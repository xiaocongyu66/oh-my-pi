/**
 * Training loop — TS port of the SkillOpt/ReflACT trainer main loop
 * (skillopt/engine/trainer.py), scaled down to omp's harvested-task size:
 * one step consumes the whole train split as a single minibatch
 * (batch_size*accumulation ≥ train_size in the original), so steps and
 * epochs coincide; the six-stage step structure and the current/best
 * double-track gate are preserved exactly.
 *
 * Per step (trainer.py:1229-1559):
 *   ① ROLLOUT   target model answers train tasks under the current skill
 *   ② REFLECT   optimizer proposes edits from failures + step buffer
 *   ③ AGGREGATE single-batch merge (merge_patches reduces to identity here)
 *   ④ SELECT    rankAndSelect clips the pool to the edit budget (clip.py)
 *   ⑤ UPDATE    applyPatchWithReport applies verbatim-target edits (skill.py)
 *   ⑥ EVALUATE  gate on the selection set — three-state, current AND best
 *               baselines, strict `>` both ways (evaluation/gate.py)
 *
 * The selection set is ONLY ever scored in ⑥ — its prompts never enter the
 * optimizer (that separation is the validation gate's whole point). A
 * selection cache keyed by skill hash avoids re-scoring unchanged documents
 * (trainer.py:1077-1082). IO is injected via EvolutionStorage; model calls
 * via transports, so the loop is unit-testable with scripted models.
 */
import type { ModelTransport } from "./judge";
import { evaluateGate, type GateMetric, type GateOptions } from "./gate";
import { editSummary, proposeEdits, rankAndSelect, selectLowRollouts, applyPatchWithReport } from "./optimizer";
import { skillVersion } from "./storage";
import { countAbstentions, runCondition, conditionScore } from "./rollout";
import type { EvolutionStorage } from "./storage";
import type { EvalSplit, EvolutionState, Rollout, StepRecord, TrainingRunResult } from "./types";

export interface TrainConfig {
	/** Total steps the loop runs (num_epochs × steps_per_epoch; 1 batch/step here). */
	maxEpochs: number;
	/** Max edits per step at t=0 (cfg["edit_budget"]; scheduler max_lr). */
	learningRate: number;
	/** Scheduler floor (min_learning_rate): cosine anneals down to this. */
	minLearningRate: number;
	/** Defensive content cap per step, in estimated tokens. */
	editBudgetTokens: number;
	/** Stop after this many consecutive steps without a gate pass (omp add-on;
	 *  the original relies on num_epochs alone). */
	earlyStopSteps: number;
	/** Reflect only sees rollouts below this quality (0..1). */
	lowQualityCutoff: number;
	/** Gate metric projection (gate.py: hard | soft | mixed). */
	gateMetric: GateMetric;
	gateMixedWeight: number;
}

export const DEFAULT_TRAIN_CONFIG: TrainConfig = {
	maxEpochs: 8,
	learningRate: 3,
	minLearningRate: 2,
	editBudgetTokens: 4000,
	earlyStopSteps: 3,
	lowQualityCutoff: 0.6,
	gateMetric: "soft",
	gateMixedWeight: 0.5,
};

/**
 * Cosine edit-budget scheduler (scheduler.py:87-92): lr decays from max to
 * min over total steps — `lr = min + 0.5*(max-min)*(1+cos(pi*t))` with
 * `t = step/total`, rounded (banker's rounding, matching Python round()),
 * floored at min. Every step consumes the budget (rejected steps included,
 * trainer.py:1415). Degenerate totals (≤1) stay at max_lr.
 */
export function cosineEditBudget(step: number, total: number, max: number, min: number): number {
	if (total <= 1) return Math.max(min, max);
	const t = Math.min(1, Math.max(0, step / total));
	const lr = min + 0.5 * (max - min) * (1 + Math.cos(Math.PI * t));
	const floor = Math.floor(lr);
	const frac = lr - floor;
	// Python round(): half goes to the EVEN neighbour.
	let rounded: number;
	if (frac > 0.5) rounded = floor + 1;
	else if (frac < 0.5) rounded = floor;
	else rounded = floor % 2 === 0 ? floor : floor + 1;
	return Math.max(min, rounded);
}

export interface TrainerDeps {
	storage: EvolutionStorage;
	target: ModelTransport;
	targetModel: string;
	judge: ModelTransport;
	judgeModel: string;
	optimizer: ModelTransport;
	optimizerModel: string;
	config?: Partial<TrainConfig>;
	signal?: AbortSignal;
	/** Invoked with the best skill text after gate convergence. */
	onL2Verify?: (bestSkill: string, split: EvalSplit) => Promise<boolean>;
	/** Invoked after a promoted result — caller performs promotion. */
	onPromoted?: (bestSkill: string, state: EvolutionState) => Promise<void>;
}

const now = () => new Date().toISOString();

async function ledger(
	deps: TrainerDeps,
	event: Parameters<EvolutionStorage["appendLedger"]>[0]["event"],
	detail: string,
	step?: number,
) {
	await deps.storage.appendLedger({ ts: now(), event, skill: deps.storage.slug, step, detail });
}

/**
 * Run one full training session for a skill. Assumes eval split + seed skill
 * already exist in storage (the command layer prepares them via harvest).
 *
 * Wrapper guarantees the red-line invariant: NO exit path (throw, abort
 * mid-await, disk error) can leave `state.json` stuck in `"training"` —
 * the status is rewritten to `"error"` before the error propagates.
 */
export async function trainSkill(deps: TrainerDeps): Promise<TrainingRunResult> {
	try {
		return await runTrainingSession(deps);
	} catch (err) {
		try {
			const state = await deps.storage.readState();
			if (state && state.status === "training") {
				state.status = "error";
				await deps.storage.writeState(state);
				await deps.storage.appendLedger({
					ts: new Date().toISOString(),
					event: "error",
					skill: deps.storage.slug,
					detail: err instanceof Error ? err.message : String(err),
				});
			}
		} catch {
			// Disk is failing too; the throw below still reports the real cause.
		}
		throw err;
	}
}

async function runTrainingSession(deps: TrainerDeps): Promise<TrainingRunResult> {
	const config: TrainConfig = { ...DEFAULT_TRAIN_CONFIG, ...deps.config };
	const { storage, signal } = deps;
	const split = await storage.readSplit();
	if (split.train.length + split.heldout.length === 0) {
		return {
			skill: storage.slug,
			steps: [],
			promoted: false,
			reason: "error",
			bestVersion: "",
			error: "no eval tasks harvested",
		};
	}

	let currentSkill = (await storage.readSkill()) ?? "";
	const gateOpts: GateOptions = {
		metric: config.gateMetric,
		mixedWeight: config.gateMixedWeight,
		useSemanticDensity: false,
		semanticDensityWeight: 0.05,
	};

	// Runtime state (trainer.py:984-1046): current/best double track.
	let state: EvolutionState = (await storage.readState()) ?? {
		skill: storage.slug,
		version: skillVersion(currentSkill),
		bestVersion: skillVersion(currentSkill),
		step: 0,
		bestStep: 0,
		currentScore: -1,
		bestScore: -1,
		rejectedBuffer: [],
		lastRunDate: undefined,
		status: "idle",
	};
	state.status = "training";
	await storage.writeState(state);

	const rolloutDeps = {
		target: deps.target,
		targetModel: deps.targetModel,
		judge: deps.judge,
		judgeModel: deps.judgeModel,
		signal,
	};

	// Selection cache: skill hash → (hard, soft) (trainer.py:1077-1082).
	const selCache = new Map<string, { hard: number; soft: number }>();

	async function selectionScore(
		skillText: string,
		label: string,
	): Promise<{ hard: number; soft: number } | undefined> {
		const hash = skillVersion(skillText);
		const cached = selCache.get(hash);
		if (cached) return cached;
		const rollouts = await runCondition(split.heldout, skillText, label, rolloutDeps);
		const agg = conditionScore(rollouts);
		if (agg.n === 0) return undefined; // fully abstained → gate undecidable
		const entry = { hard: agg.hard, soft: agg.soft };
		selCache.set(hash, entry);
		return entry;
	}

	// Baseline evaluation on the selection set (trainer.py:1129-1159).
	if (state.currentScore < 0) {
		const baseline = await selectionScore(currentSkill, "baseline");
		if (!baseline) {
			await ledger(deps, "error", "selection baseline fully abstained; cannot gate");
			state.status = "error";
			await storage.writeState(state);
			return {
				skill: storage.slug,
				steps: [],
				promoted: false,
				reason: "error",
				bestVersion: state.version,
				error: "baseline fully abstained",
			};
		}
		state.currentScore =
			gateOpts.metric === "hard"
				? baseline.hard
				: gateOpts.metric === "soft"
					? baseline.soft
					: (1 - gateOpts.mixedWeight) * baseline.hard + gateOpts.mixedWeight * baseline.soft;
		state.bestScore = state.currentScore;
		state.version = skillVersion(currentSkill);
		state.bestVersion = state.version;
		await storage.writeState(state);
		await ledger(
			deps,
			"step-end",
			`baseline selection hard=${baseline.hard.toFixed(3)} soft=${baseline.soft.toFixed(3)}`,
			0,
		);
	}

	const steps: StepRecord[] = [];
	let stepsSinceGatePass = 0;
	let earlyStopped = false;

	for (let step = state.step + 1; step <= config.maxEpochs; step++) {
		if (signal?.aborted) {
			await ledger(deps, "cancelled", `aborted before step ${step}`, step);
			state.status = "idle";
			await storage.writeState(state);
			return { skill: storage.slug, steps, promoted: false, reason: "cancelled", bestVersion: state.bestVersion };
		}
		state.step = step;
		await ledger(deps, "step-start", "", step);

		// ① ROLLOUT on train split under the current skill.
		const trainRollouts: Rollout[] = await runCondition(split.train, currentSkill, "current", rolloutDeps);
		const trainAgg = conditionScore(trainRollouts);

		// ② REFLECT — proposals from failures + rejection buffer.
		const low = selectLowRollouts(trainRollouts, 6).filter(
			r => (r.score.quality as number) < config.lowQualityCutoff,
		);
		const proposals = low.length
			? await proposeEdits({
					transport: deps.optimizer,
					model: deps.optimizerModel,
					skill: currentSkill,
					lowRollouts: low,
					rejectedBuffer: state.rejectedBuffer.slice(-10),
					limits: { maxEdits: config.learningRate, budgetTokens: config.editBudgetTokens },
					signal,
				})
			: [];

		// No usable patches → skill unchanged (trainer.py:1338-1360).
		if (proposals.length === 0) {
			const record: StepRecord = {
				step,
				epoch: step,
				action: "skip_no_patches",
				proposed: [],
				accepted: [],
				rejected: [],
				applyReports: [],
				candidateHash: "",
				selectionHardBefore: -1,
				selectionSoftBefore: -1,
				selectionHardAfter: -1,
				selectionSoftAfter: -1,
				gateAction: "skipped",
				trainHard: trainAgg.hard,
				trainSoft: trainAgg.soft,
				abstentions: countAbstentions(trainRollouts),
			};
			await storage.writeStep(record);
			steps.push(record);
			await ledger(deps, "step-end", "skip_no_patches", step);
			await storage.writeState(state);
			stepsSinceGatePass++;
			if (stepsSinceGatePass >= config.earlyStopSteps) {
				await ledger(deps, "early-stop", `${stepsSinceGatePass} steps without gate pass`, step);
				earlyStopped = true;
				break;
			}
			continue;
		}

		// ④ SELECT — clip pool to this step's edit budget. Reflect's own cap
		// stays at the fixed learningRate (original double-budget discipline:
		// the scheduler only governs SELECT, trainer.py:1415).
		const editBudget = cosineEditBudget(step, config.maxEpochs, config.learningRate, config.minLearningRate);
		const ranked = await rankAndSelect({
			transport: deps.optimizer,
			model: deps.optimizerModel,
			skill: currentSkill,
			edits: proposals,
			maxEdits: editBudget,
			signal,
		});

		// ⑤ UPDATE — verbatim-target edits with per-edit reports. A no-op apply
		// (every edit skipped/missed) leaves candidate == current; the original
		// does NOT special-case this — the gate sees an unchanged candidate and
		// rejects on the strict-> tie (spec trap: cand==current ⇒ reject), which
		// routes the edits into the rejection buffer exactly like any reject.
		const { text: candidateSkill, reports } = applyPatchWithReport(currentSkill, ranked);
		const candidateHash = skillVersion(candidateSkill);

		// ⑥ EVALUATE — three-state gate on the selection set.
		const candAgg = await selectionScore(candidateSkill, "candidate");
		let gateAction: StepRecord["gateAction"] = "skipped";
		if (candAgg) {
			const gate = evaluateGate(
				{
					candidateSkill,
					candHard: candAgg.hard,
					candSoft: candAgg.soft,
					currentScore: state.currentScore,
					bestScore: state.bestScore,
					bestStep: state.bestStep,
					globalStep: step,
				},
				gateOpts,
			);
			gateAction = gate.action;
			if (gate.action === "reject") {
				for (const e of ranked) {
					state.rejectedBuffer.push(editSummary(e));
					await ledger(deps, "edit-rejected", editSummary(e), step);
				}
				if (state.rejectedBuffer.length > 20) state.rejectedBuffer.splice(0, state.rejectedBuffer.length - 20);
				stepsSinceGatePass++;
			} else {
				// accept / accept_new_best: candidate becomes current (gate.py
				// returns current_skill=candidate for BOTH accept actions).
				currentSkill = candidateSkill;
				state.version = await storage.writeSkill(candidateSkill);
				await storage.snapshotCandidate(candidateSkill, state.version);
				state.currentScore = gate.candScore;
				stepsSinceGatePass = 0;
				for (const e of ranked) await ledger(deps, "edit-accepted", editSummary(e), step);
				if (gate.action === "accept_new_best") {
					state.bestScore = gate.candScore;
					state.bestStep = step;
					state.bestVersion = state.version;
					await storage.writeBestSkill(candidateSkill);
				}
			}
		} else {
			// Selection fully abstained → gate undecidable → conservative reject.
			gateAction = "reject";
			for (const e of ranked) {
				state.rejectedBuffer.push(editSummary(e));
				await ledger(deps, "edit-rejected", `${editSummary(e)} (selection abstained)`, step);
			}
			stepsSinceGatePass++;
		}

		const record: StepRecord = {
			step,
			epoch: step,
			action: gateAction === "skipped" ? "reject" : gateAction,
			proposed: ranked,
			accepted: gateAction === "accept" || gateAction === "accept_new_best" ? ranked : [],
			rejected: gateAction === "accept" || gateAction === "accept_new_best" ? [] : ranked,
			applyReports: reports,
			candidateHash,
			selectionHardBefore: -1,
			selectionSoftBefore: -1,
			selectionHardAfter: candAgg?.hard ?? -1,
			selectionSoftAfter: candAgg?.soft ?? -1,
			gateAction,
			trainHard: trainAgg.hard,
			trainSoft: trainAgg.soft,
			abstentions: countAbstentions(trainRollouts),
		};
		await storage.writeStep(record);
		steps.push(record);
		await ledger(
			deps,
			"step-end",
			`gate=${gateAction} current=${state.currentScore.toFixed(3)} best=${state.bestScore.toFixed(3)}`,
			step,
		);
		await storage.writeState(state);

		if (stepsSinceGatePass >= config.earlyStopSteps) {
			await ledger(deps, "early-stop", `${stepsSinceGatePass} steps without gate pass`, step);
			earlyStopped = true;
			break;
		}
	}

	// Final re-evaluation (trainer.py:2229-2275): after the loop, score the
	// final current skill on the selection set (cache usually hits) and
	// promote it over best if the gate metric strictly improves.
	const finalAgg = await selectionScore(currentSkill, "final");
	if (finalAgg) {
		const finalScore =
			gateOpts.metric === "hard"
				? finalAgg.hard
				: gateOpts.metric === "soft"
					? finalAgg.soft
					: (1 - gateOpts.mixedWeight) * finalAgg.hard + gateOpts.mixedWeight * finalAgg.soft;
		if (finalScore > state.bestScore) {
			state.bestScore = finalScore;
			state.bestStep = state.step;
			state.bestVersion = skillVersion(currentSkill);
			await storage.writeBestSkill(currentSkill);
			await ledger(deps, "edit-accepted", `final skill promoted over best (${finalScore.toFixed(3)})`, state.step);
		}
	}

	// Gate convergence → optional L2 verification → promotion handoff.
	let promoted = false;
	const bestSkill = await storage.readBestSkill();
	let reason: TrainingRunResult["reason"] =
		bestSkill !== undefined ? "gate-passed" : earlyStopped ? "early-stop" : "gate-never-passed";
	if (bestSkill !== undefined && deps.onL2Verify) {
		state.status = "l2-verify";
		await storage.writeState(state);
		await ledger(deps, "l2-start", `${split.heldout.length} tasks`);
		const passed = await deps.onL2Verify(bestSkill, split);
		await ledger(deps, "l2-end", passed ? "passed" : "failed");
		if (passed) {
			promoted = true;
			reason = "promoted";
			state.status = "promoted";
			state.lastRunDate = now().slice(0, 10);
			await deps.onPromoted?.(bestSkill, state);
		} else {
			reason = "l2-failed";
			state.status = "idle";
		}
	} else {
		state.status = "idle";
	}
	await storage.writeState(state);
	if (promoted) await ledger(deps, "promoted", state.bestVersion);
	return { skill: storage.slug, steps, promoted, reason, bestVersion: state.bestVersion };
}
