/**
 * L2 real-execution verification — the final promotion gate. Runs each held-out
 * task through a headless `omp -p` session and judges the session's final output.
 *
 * SkillOpt anchors (original Python, cloned at /tmp/skillopt-src):
 * - Sleep Stage 3 "replay" (`skillopt_sleep/replay.py:30-91` replay_one:
 *   attempt the task under a skill, then judge → (hard, soft)) executed through
 *   the trainer's real-exec backend: `skillopt/model/codex_harness.py:1977`
 *   (run_target_exec) spawns the agent CLI headless in a prepared work_dir —
 *   `_run_claude_code_cli_exec` (:884-954) uses print mode `-p` with
 *   `cwd=work_dir` (:933) and a wall-clock timeout (:936); stdout is the
 *   response (:951).
 * - Sleep Stage 4 "consolidate" gate (`skillopt_sleep/consolidate.py:180+`)
 *   accepts a candidate only when the aggregate val-slice score improves, where
 *   the aggregate is `aggregate_scores` (`replay.py:127-132`): the MEAN of hard
 *   over every returned row — a pass ratio is never used. Trainer-side this is
 *   ⑥ EVALUATE (`skillopt/engine/trainer.py:1560-1577`): adapter.rollout on the
 *   held-out selection set → `compute_score` (`skillopt/utils/scoring.py:21`,
 *   `sum(hard) / len(results)`).
 * - Failure counting: a sample that times out or errors still lands in the
 *   batch as a `hard=0, soft=0.0` row (`skillopt/envs/searchqa/rollout.py:404-425`
 *   _timeout_result/_error_result, appended at :476-489) and a process_one
 *   exception keeps the hard=0 default (:187-201, :351-354) — failed/missing
 *   samples are counted, never dropped. consolidate.py:145-163 plus
 *   `docs/sleep/README.md:33` extend the same fail-closed stance: "A missing
 *   task result or non-finite task score also blocks the gate".
 *
 * `passed` therefore follows the original mean-of-hard counting:
 * `sum(pass ? 1 : 0) / tasks.length >= passThreshold`, where every task feeds
 * the denominator and timed-out, non-completed, spawn-failed and
 * judge-abstained samples all contribute 0 (the original has no abstention
 * lane — an unjudgeable sample is just a hard=0 row). A judged sample counts
 * its verdict wherever a response exists, mirroring the original which scores
 * stdout even when the CLI exited non-zero (`codex_harness.py:951-953`); a
 * timeout/empty-stdout row has no response and scores 0 (:938-944, :952-953).
 * This intentionally differs from L1's `computeScore` (scoring.ts), which
 * excludes abstentions to keep flaky judging from moving the L1 gate — at L2 a
 * missing verdict IS a failed verification.
 *
 * No code path throws: every failure mode degrades to a hard=0 sample.
 */
import { judgeAnswer, type ModelTransport } from "./judge";
import type { EvolutionStorage } from "./storage";
import type { L2SampleResult, RolloutScore, TrainingTask } from "./types";

export interface L2Options {
	/** omp binary to spawn; defaults to "omp" on PATH. */
	ompPath?: string;
	/** Wall-clock bound per sample, mirroring the original exec timeout (codex_harness.py:936). */
	timeoutMs: number;
	/** Working directory the headless session runs in (original cwd=work_dir, codex_harness.py:933). */
	workdir: string;
	/** Minimum mean-of-hard fraction for the batch to pass (compare aggregate_scores + gate). */
	passThreshold: number;
}

export interface L2Deps {
	judge: ModelTransport;
	judgeModel: string;
	opts: L2Options;
	signal?: AbortSignal;
	/** When present, a summary `l2-end` ledger entry is appended (audit trail). */
	storage?: EvolutionStorage;
}

const DEFAULT_OMPPATH = "omp";

/** Hard outcome of one sample: the judge's pass verdict, or undefined when no response existed / judging abstained. */
interface L2SampleDetail {
	sample: L2SampleResult;
	/** Judge pass verdict (searchqa rollout sets `hard = int(EM)` from the response, rollout.py:247). */
	pass: boolean | undefined;
}

function failedSample(taskId: string, timedOut = false): L2SampleDetail {
	return { sample: { taskId, completed: false, timedOut, score: undefined }, pass: undefined };
}

/**
 * Judge the stdout of one headless session. Empty stdout is not judged
 * (original timeout path returns "" and scores 0 without a judge round,
 * codex_harness.py:938-944); a judge transport error degrades to undefined.
 */
async function judgeL2Stdout(
	task: TrainingTask,
	stdout: string,
	deps: L2Deps,
): Promise<{ score: number | undefined; pass: boolean | undefined }> {
	const answer = stdout.trim();
	if (!answer) return { score: undefined, pass: undefined };
	try {
		const verdict: RolloutScore = await judgeAnswer({
			transport: deps.judge,
			model: deps.judgeModel,
			task,
			answer,
			signal: deps.signal,
		});
		// Abstained verdicts carry neither pass nor quality (types.ts RolloutScore).
		return { score: verdict.quality, pass: verdict.pass };
	} catch {
		return { score: undefined, pass: undefined };
	}
}

/**
 * Run ONE held-out task through a real headless omp session and judge the
 * result. Timeout → timedOut + hard=0; non-zero exit → completed=false but the
 * stdout is still judged when present (codex_harness.py:951-953); spawn
 * failures (ENOENT, aborted signal) degrade to a failed sample. Never throws.
 */
export async function runRealSample(task: TrainingTask, deps: L2Deps): Promise<L2SampleResult> {
	return (await runSampleDetailed(task, deps)).sample;
}

async function runSampleDetailed(task: TrainingTask, deps: L2Deps): Promise<L2SampleDetail> {
	const aborted = (): boolean => deps.signal?.aborted === true;
	try {
		if (aborted()) return failedSample(task.id);
		const proc = Bun.spawn([deps.opts.ompPath ?? DEFAULT_OMPPATH, "-p", task.prompt], {
			cwd: deps.opts.workdir,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		let timedOut = false;
		const kill = (): void => {
			try {
				proc.kill("SIGKILL");
			} catch {
				// Already exited; nothing to reap.
			}
		};
		const timer = setTimeout(
			() => {
				timedOut = true;
				kill();
			},
			Math.max(1, deps.opts.timeoutMs),
		);
		const onAbort = (): void => kill();
		deps.signal?.addEventListener("abort", onAbort, { once: true });
		let stdout = "";
		try {
			[stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		} finally {
			clearTimeout(timer);
			deps.signal?.removeEventListener("abort", onAbort);
		}
		if (timedOut) {
			// _timeout_result (searchqa/rollout.py:404-419): hard=0 row, stays in the batch.
			return failedSample(task.id, true);
		}
		if (aborted()) return failedSample(task.id);
		const { score, pass } = await judgeL2Stdout(task, stdout, deps);
		return { sample: { taskId: task.id, completed: proc.exitCode === 0, timedOut: false, score }, pass };
	} catch {
		// Spawn failure (ENOENT et al.) — a hard=0 row, like process_one's
		// exception path (searchqa/rollout.py:351-354). Never propagate.
		return failedSample(task.id);
	}
}

/**
 * Verify a candidate skill on the held-out tasks via real execution and decide
 * pass/fail with the original aggregate semantics: `aggregate_scores`
 * (replay.py:127-132) / `compute_score` (scoring.py:21) — mean of hard over
 * ALL samples with failed/missing ones counted as 0, compared against
 * `passThreshold`. An empty task list scores 0.0 (scoring.py:12-13) and fails.
 * Samples run sequentially (same policy as L1's runCondition).
 */
export async function runL2Verification(
	tasks: TrainingTask[],
	deps: L2Deps,
): Promise<{ results: L2SampleResult[]; passed: boolean }> {
	const details: L2SampleDetail[] = [];
	for (const task of tasks) {
		if (deps.signal?.aborted) break;
		details.push(await runSampleDetailed(task, deps));
	}
	// Mean-of-hard over every task (failures count 0, never dropped) —
	// scoring.py:21 / replay.py:130. Empty batch → 0.0 (scoring.py:12-13).
	const meanHard =
		tasks.length === 0 ? 0 : details.reduce((acc, d) => acc + (d.pass === true ? 1 : 0), 0) / tasks.length;
	const passed = meanHard >= deps.opts.passThreshold;
	if (deps.storage) {
		const completed = details.filter(d => d.sample.completed).length;
		const timedOut = details.filter(d => d.sample.timedOut).length;
		const abstained = details.filter(d => d.pass === undefined).length;
		await deps.storage.appendLedger({
			ts: new Date().toISOString(),
			event: "l2-end",
			skill: "",
			detail: `passed=${passed} hardMean=${meanHard.toFixed(3)} threshold=${deps.opts.passThreshold} completed=${completed}/${tasks.length} timedOut=${timedOut} abstained=${abstained}`,
		});
	}
	return { results: details.map(d => d.sample), passed };
}
