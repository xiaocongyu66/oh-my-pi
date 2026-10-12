/**
 * Rollouts. L1 (this file's main path): simulated — the target model answers
 * each task WITHOUT and WITH the candidate skill, and the judge scores both
 * answers; the per-task delta is the training signal (SkillOpt rollout+score).
 *
 * L2 real execution (replaying a task through a headless `omp -p` session)
 * lives in `l2.ts` and only ever runs AFTER L1 gating passed.
 */
import type { ModelTransport } from "./judge";
import { judgeAnswer } from "./judge";
import { computeScore, type ScoreAggregate } from "./scoring";
import type { Rollout, RolloutScore, TrainingTask } from "./types";

export interface RolloutDeps {
	/** Answers tasks as the deployed agent would. */
	target: ModelTransport;
	targetModel: string;
	/** Grades answers. */
	judge: ModelTransport;
	judgeModel: string;
	signal?: AbortSignal;
}

/** Target-model system prompt for a rollout: no skill, or the given skill.md. */
export function rolloutSystemPrompt(skillContent: string | undefined): string {
	return skillContent
		? `You are completing a software task. Apply this learned skill guidance:\n<skill>\n${skillContent}\n</skill>`
		: "You are completing a software task.";
}

export async function runRollout(
	task: TrainingTask,
	skillContent: string | undefined,
	skillVersion: string,
	deps: RolloutDeps,
): Promise<Rollout> {
	const answer = await deps.target({
		model: deps.targetModel,
		system: rolloutSystemPrompt(skillContent),
		prompt: task.prompt,
		signal: deps.signal,
	});
	const score = await judgeAnswer({
		transport: deps.judge,
		model: deps.judgeModel,
		task,
		answer,
		signal: deps.signal,
	});
	return { taskId: task.id, skillVersion, answer, score };
}

/** Score every task under one skill condition (sequential — keeps mock
 *  transports deterministic and provider load predictable). */
export async function runCondition(
	tasks: TrainingTask[],
	skillContent: string | undefined,
	skillVersion: string,
	deps: RolloutDeps,
): Promise<Rollout[]> {
	const out: Rollout[] = [];
	for (const task of tasks) {
		if (deps.signal?.aborted) break;
		out.push(await runRollout(task, skillContent, skillVersion, deps));
	}
	return out;
}

/** (hard, soft) aggregate of one condition's rollouts (scoring.py compute_score). */
export function conditionScore(rollouts: Rollout[]): ScoreAggregate {
	return computeScore(rollouts.map(r => r.score));
}

export function countAbstentions(rollouts: Rollout[]): number {
	return rollouts.filter(r => r.score.abstained).length;
}

/** Per-task quality delta of the with-skill condition over the no-skill baseline. */
export function scoreDeltas(baseline: Rollout[], candidate: Rollout[]): Map<string, number | undefined> {
	const base = new Map<string, RolloutScore>(baseline.map(r => [r.taskId, r.score]));
	const out = new Map<string, number | undefined>();
	for (const cand of candidate) {
		const before = base.get(cand.taskId);
		if (
			!before ||
			before.abstained ||
			cand.score.abstained ||
			typeof before.quality !== "number" ||
			typeof cand.score.quality !== "number"
		) {
			out.set(cand.taskId, undefined);
			continue;
		}
		out.set(cand.taskId, cand.score.quality - before.quality);
	}
	return out;
}
