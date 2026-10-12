/**
 * Aggregate scoring — byte-faithful TS port of SkillOpt
 * `skillopt/utils/scoring.py` compute_score: a rollout batch reduces to
 * (hard, soft) in 0..1 by dividing over EVERY result — rows without a verdict
 * (timeout, empty output, judge abstention) count as hard=0/soft=0 and stay
 * in the denominator, exactly like the original's failed episodes. An empty
 * batch yields (0, 0), matching `if not results: return 0.0, 0.0`.
 *
 * The gate (gate.ts) then projects (hard, soft) onto its comparison metric.
 */
import type { RolloutScore } from "./types";

export interface ScoreAggregate {
	/** Fraction of hard passes over ALL rows (failed/abstained rows count 0). */
	hard: number;
	/** Mean partial credit over ALL rows. */
	soft: number;
	/** Number of rows in the batch (denominator of both aggregates). */
	n: number;
}

export function computeScore(scores: RolloutScore[]): ScoreAggregate {
	if (scores.length === 0) return { hard: 0, soft: 0, n: 0 };
	let hard = 0;
	let soft = 0;
	for (const s of scores) {
		if (!s.abstained && typeof s.pass === "boolean") hard += s.pass ? 1 : 0;
		if (!s.abstained && typeof s.quality === "number") soft += s.quality;
	}
	return { hard: hard / scores.length, soft: soft / scores.length, n: scores.length };
}
