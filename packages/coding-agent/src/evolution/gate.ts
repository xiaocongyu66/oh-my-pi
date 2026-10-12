/**
 * Validation gate — TS port of SkillOpt `skillopt/evaluation/gate.py`.
 *
 * Three-state decision (accept_new_best / accept / reject) comparing the
 * candidate against BOTH the current and best-so-far skill, on a selection
 * (held-out) set. Pure decision function — the trainer owns all side effects,
 * exactly like the original module docstring states.
 *
 * Metrics (original gate.py:10-23):
 * - "hard": exact-match accuracy (default, backward compatible)
 * - "soft": per-item partial credit (F1-like) — for small selection sets
 * - "mixed": (1-w)*hard + w*soft, w = mixedWeight
 * Optional semantic-density bonus on leading words (gate.py:46-132).
 */

export type GateAction = "accept_new_best" | "accept" | "reject";
export type GateMetric = "hard" | "soft" | "mixed";

export interface GateInput {
	/** Candidate skill document content (for the density bonus). */
	candidateSkill: string;
	candHard: number;
	candSoft: number;
	currentScore: number;
	bestScore: number;
	bestStep: number;
	globalStep: number;
}

export interface GateOptions {
	metric: GateMetric;
	mixedWeight: number;
	useSemanticDensity: boolean;
	semanticDensityWeight: number;
	leadingWords?: string[];
}

export interface GateResult {
	action: GateAction;
	candScore: number;
	bestScore: number;
	bestStep: number;
}

export const DEFAULT_LEADING_WORDS = [
	"MUST",
	"ALWAYS",
	"NEVER",
	"ONLY",
	"CRITICAL",
	"IMPORTANT",
	"RESOLVE",
	"PREFER",
	"ENSURE",
	"STRICT",
	"VERIFY",
];

/** Strip metadata comment blocks before counting (gate.py:59-73). */
function stripMetadataBlocks(skill: string): string {
	let out = skill;
	for (const [start, end] of [
		["<!-- SLOW_UPDATE_START -->", "<!-- SLOW_UPDATE_END -->"],
		["<!-- APPENDIX_START -->", "<!-- APPENDIX_END -->"],
	]) {
		while (true) {
			const s = out.indexOf(start);
			if (s === -1) break;
			const e = out.indexOf(end, s);
			if (e === -1) {
				out = out.slice(0, s);
				break;
			}
			out = out.slice(0, s) + out.slice(e + end.length);
		}
	}
	return out;
}

/** gate.py:46-82 — share of leading (high-influence) words. */
export function computeSemanticDensity(skillContent: string, leadingWords?: string[]): number {
	if (!skillContent || !skillContent.trim()) return 0;
	const words = stripMetadataBlocks(skillContent)
		.toLowerCase()
		.match(/[a-z0-9]+/g);
	if (!words || words.length === 0) return 0;
	const leading = new Set((leadingWords ?? DEFAULT_LEADING_WORDS).map(w => w.toLowerCase()));
	const count = words.reduce((acc, w) => acc + (leading.has(w) ? 1 : 0), 0);
	return count / words.length;
}

/** gate.py:85-132 — project (hard, soft) onto one comparison metric. */
export function selectGateScore(hard: number, soft: number, opts: GateOptions, skillContent: string): number {
	let score: number;
	if (opts.metric === "hard") {
		score = hard;
	} else if (opts.metric === "soft") {
		score = soft;
	} else {
		const w = Math.min(1, Math.max(0, opts.mixedWeight));
		score = (1 - w) * hard + w * soft;
	}
	if (opts.useSemanticDensity) {
		score += opts.semanticDensityWeight * computeSemanticDensity(skillContent, opts.leadingWords);
	}
	return score;
}

/** gate.py:135-225 — pure three-state gate decision. Strict `>` both ways. */
export function evaluateGate(input: GateInput, opts: GateOptions): GateResult {
	const candScore = selectGateScore(input.candHard, input.candSoft, opts, input.candidateSkill);
	if (candScore > input.currentScore) {
		if (candScore > input.bestScore) {
			return { action: "accept_new_best", candScore, bestScore: candScore, bestStep: input.globalStep };
		}
		return { action: "accept", candScore, bestScore: input.bestScore, bestStep: input.bestStep };
	}
	return { action: "reject", candScore, bestScore: input.bestScore, bestStep: input.bestStep };
}
