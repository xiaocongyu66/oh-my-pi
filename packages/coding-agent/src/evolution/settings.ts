/**
 * Settings declared by the skill-evolution domain (see `config/registry.ts`).
 *
 * Master flag `skillEvolution.enabled` is default-off: no harvest, no
 * training, no nightly run, no promotion until the user turns it on.
 * Model defaults fall back to the advisor role when unset.
 */
import { register } from "../config/registry";

export const cfgEvolutionEnabled = register({
	id: "skillEvolution.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "memory",
		group: "Skill Evolution",
		label: "Skill evolution trainer (experimental)",
		description: "Train managed skills with validation-gated edits harvested from past sessions (SkillOpt method)",
	},
});

/** Judge/optimizer model ids; empty = fall back to the advisor role model. */
export const cfgEvolutionJudgeModel = register({
	id: "skillEvolution.judgeModel",
	type: "string",
	default: "",
	ui: {
		tab: "memory",
		group: "Skill Evolution",
		label: "Judge model",
		description: "Model id used to score rollouts. Empty = advisor model",
	},
});

export const cfgEvolutionOptimizerModel = register({
	id: "skillEvolution.optimizerModel",
	type: "string",
	default: "",
	ui: {
		tab: "memory",
		group: "Skill Evolution",
		label: "Optimizer model",
		description: "Model id that proposes skill edits. Empty = advisor model",
	},
});

// ─── Nightly schedule ────────────────────────────────────────────────────────

export const cfgEvolutionScheduleEnabled = register({
	id: "skillEvolution.schedule.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "memory",
		group: "Skill Evolution",
		label: "Nightly training",
		description: "Run training automatically once per day while omp stays open",
	},
});

/** Local wall-clock time "HH:MM" (24h). Numbers without options are hidden
 *  from the UI, so time is a string rendered as free text. */
export const cfgEvolutionScheduleTime = register({
	id: "skillEvolution.schedule.time",
	type: "string",
	default: "02:30",
	ui: {
		tab: "memory",
		group: "Skill Evolution",
		label: "Nightly start time",
		description: 'Local time to start the nightly run, "HH:MM" 24-hour',
	},
});

// ─── Training-loop knobs ─────────────────────────────────────────────────────

export const cfgEvolutionMaxEpochs = register({ id: "skillEvolution.maxEpochs", type: "number", default: 8 });
/** SkillOpt textual learning rate: max EditOps the optimizer may propose per epoch. */
export const cfgEvolutionLearningRate = register({ id: "skillEvolution.learningRate", type: "number", default: 3 });
/** Token budget for the total content of proposed edits per epoch. */
export const cfgEvolutionEditBudgetTokens = register({
	id: "skillEvolution.editBudgetTokens",
	type: "number",
	default: 4000,
});
export const cfgEvolutionHeldoutFraction = register({
	id: "skillEvolution.heldoutFraction",
	type: "number",
	default: 0.2,
});
/** Stop after this many consecutive epochs without a strict gate pass. */
export const cfgEvolutionEarlyStopEpochs = register({
	id: "skillEvolution.earlyStopEpochs",
	type: "number",
	default: 3,
});
/** L2 (real-execution) verification: how many held-out tasks to replay. */
export const cfgEvolutionL2SampleSize = register({ id: "skillEvolution.l2SampleSize", type: "number", default: 3 });
/** Per-sample timeout for L2 headless execution, seconds. */
export const cfgEvolutionL2TimeoutSec = register({ id: "skillEvolution.l2TimeoutSec", type: "number", default: 600 });
/** Minimum harvested tasks required before training may start. */
export const cfgEvolutionMinTasks = register({ id: "skillEvolution.minTasks", type: "number", default: 5 });
/** Dedicated model id for L2 sandbox approval review; empty falls back to the judge model. */
export const cfgEvolutionApprovalModel = register({ id: "skillEvolution.approvalModel", type: "string", default: "" });
