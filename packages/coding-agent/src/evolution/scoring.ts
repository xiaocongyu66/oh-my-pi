/**
 * Aggregate scoring — TS counterpart of SkillOpt `skillopt/utils/scoring.py`
 * compute_score: a rollout batch reduces to (hard, soft) in 0..1, which the
 * gate (gate.ts) then projects onto its comparison metric.
 *
 * Abstained verdicts are excluded from BOTH aggregates; a batch with zero
 * scored members yields n=0 and the caller must treat the gate as
 * un-decidable (conservative reject).
 */
import type { RolloutScore } from "./types";

export interface ScoreAggregate {
	/** Fraction of judged answers that fully accomplished the task. */
	hard: number;
	/** Mean partial credit across judged answers. */
	soft: number;
	/** Number of non-abstained verdicts backing the aggregates. */
	n: number;
}

export function computeScore(scores: RolloutScore[]): ScoreAggregate {
	const real = scores.filter(s => !s.abstained && typeof s.quality === "number" && typeof s.pass === "boolean");
	if (real.length === 0) return { hard: 0, soft: 0, n: 0 };
	const hard = real.filter(s => s.pass).length / real.length;
	const soft = real.reduce((acc, s) => acc + (s.quality as number), 0) / real.length;
	return { hard, soft, n: real.length };
}
