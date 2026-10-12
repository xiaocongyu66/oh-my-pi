/**
 * Core data types for the skill-evolution trainer.
 *
 * Terminology maps 1:1 to SkillOpt / ReflACT (Microsoft, arXiv 2605.23904):
 * see `README.md` in this directory for the concept → file crosswalk with
 * per-line source anchors. These types are pure data — no IO here.
 */
import type { EditOp, EditReport } from "./optimizer";

export type { EditOp, EditOpKind, EditReport } from "./optimizer";

/** One mined task instance extracted from a historical session (harvest step). */
export interface TrainingTask {
	/** Stable id: `<sessionId>#<messageIndex>`. */
	id: string;
	/** The user prompt that initiated the task in the original session. */
	prompt: string;
	/** Topic bucket this task was clustered into. */
	topic: string;
	/** Session file this task was harvested from. */
	sourceSession: string;
	/** Compact summary of the original tool trajectory, shown to the judge. */
	trajectoryDigest: string;
}

/**
 * Train / selection split. The selection set (SkillOpt `valid_seen`) is the
 * ONLY set the validation gate scores; its prompts never enter the optimizer.
 */
export interface EvalSplit {
	train: TrainingTask[];
	heldout: TrainingTask[];
}

/** Rubric dimension the judge scores an answer on. */
export interface RubricCriterion {
	name: string;
	weight: number;
}

/**
 * Judge verdict for one answer — mirrors SkillOpt compute_score's (hard, soft)
 * pair (utils/scoring.py): `pass` feeds hard accuracy, `quality` is the 0..1
 * partial-credit soft score. Abstained verdicts carry neither.
 */
export interface RolloutScore {
	taskId: string;
	/** Binary exact-match outcome; undefined when the judge abstained. */
	pass: boolean | undefined;
	/** 0..1 partial credit; undefined when the judge abstained. */
	quality: number | undefined;
	abstained: boolean;
	/** Judge rationale (audit trail). */
	rationale: string;
}

/** One rollout: target model answering one task under one skill condition. */
export interface Rollout {
	taskId: string;
	/** Skill content hash the answer was produced under ("baseline"/"candidate"). */
	skillVersion: string;
	answer: string;
	score: RolloutScore;
}

/**
 * One trainer step (SkillOpt step_rec): rollout → reflect → aggregate →
 * select → update → evaluate(gate). Persisted to `epochs/NNN.json`.
 */
export interface StepRecord {
	step: number;
	epoch: number;
	/** reflect produced nothing → skill unchanged this step. */
	action: "accept_new_best" | "accept" | "reject" | "skip_no_patches" | "skip_no_rewrite";
	proposed: EditOp[];
	accepted: EditOp[];
	rejected: EditOp[];
	/** Per-edit application reports (skill.py apply_patch_with_report). */
	applyReports: (EditReport & { index: number })[];
	/** Hash of the candidate skill evaluated this step. */
	candidateHash: string;
	/** Selection-set aggregates before/after (scoring.ts computeScore). */
	selectionHardBefore: number;
	selectionSoftBefore: number;
	selectionHardAfter: number;
	selectionSoftAfter: number;
	gateAction: "accept_new_best" | "accept" | "reject" | "skipped";
	trainHard: number;
	trainSoft: number;
	abstentions: number;
}

/** Append-only audit record for `ledger.jsonl`. */
export interface LedgerEntry {
	ts: string;
	event:
		| "harvest"
		| "step-start"
		| "step-end"
		| "edit-accepted"
		| "edit-rejected"
		| "early-stop"
		| "cancelled"
		| "l2-start"
		| "l2-end"
		| "promoted"
		| "error";
	skill: string;
	step?: number;
	detail: string;
}

/**
 * Cross-step trainer bookkeeping (trainer.py runtime state): current/best are
 * TWO tracks — the gate may accept a candidate that beats current without
 * being a new global best.
 */
export interface EvolutionState {
	skill: string;
	/** Current skill content hash. */
	version: string;
	/** Best-so-far skill content hash (deployed artifact candidate). */
	bestVersion: string;
	step: number;
	bestStep: number;
	currentScore: number;
	bestScore: number;
	/** SkillOpt rejected-edit buffer: summaries the optimizer must not repeat. */
	rejectedBuffer: string[];
	/** ISO date of the last completed run (nightly scheduler dedup). */
	lastRunDate: string | undefined;
	status: "idle" | "training" | "l2-verify" | "promoted" | "error";
}

/** Result of an L2 (real-execution) verification sample. */
export interface L2SampleResult {
	taskId: string;
	completed: boolean;
	timedOut: boolean;
	/** Judge quality of the executed session's final answer. */
	quality: number | undefined;
}

/** Full result of one training run, returned to callers (panel/CLI). */
export interface TrainingRunResult {
	skill: string;
	steps: StepRecord[];
	promoted: boolean;
	reason: "promoted" | "gate-passed" | "gate-never-passed" | "early-stop" | "cancelled" | "l2-failed" | "error";
	bestVersion: string;
	error?: string;
}
