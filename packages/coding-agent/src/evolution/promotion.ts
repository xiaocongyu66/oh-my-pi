/**
 * Promotion — turning a converged evolution run into a deployable skill.
 *
 * SkillOpt counterpart: after the gate picks a best skill, the trainer
 * persists it as `best_skill.md` (trainer.py:1739-1741 per step, 2199-2201
 * at end of run) alongside runtime state recording best_score/best_step
 * (trainer.py:1060-1075); the sleep companion then stages the consolidate
 * output for an explicit human adopt (docs/sleep/README.md:19-23,
 * skillopt_sleep/staging.py:1-5). Promotion here is that adopt step: the
 * best (already gate-accepted, L2-verified) skill text is written into the
 * managed-skills directory as a real, discoverable `SKILL.md`.
 *
 * Provenance travel with the skill as an HTML comment at the head of the
 * body — the same machine-metadata convention the original uses for
 * `<!-- SLOW_UPDATE_START -->` blocks (gate.py:59-73 strips metadata
 * comments before scoring; optimizer.ts exports the same markers). The
 * comment lives AFTER the frontmatter close delimiter, so `name`/
 * `description` frontmatter written by `toSkillFrontmatter` is untouched.
 *
 * Red line: the ONLY write path is `writeManagedSkill`, which is confined
 * to `<agentDir>/managed-skills/` (symlink/hardlink/size guarded there).
 * Promotion never writes project `.omp`/`.claude` or authored skills.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";

import { getManagedSkillsDir, sanitizeSkillName, writeManagedSkill } from "../autolearn/managed-skills";

/**
 * Audit record stamped into a promoted skill.
 *
 * Field semantics follow the original gate/runtime state:
 * - `gateAction` — GateAction of the step that produced the deployed best
 *   skill (gate.py:30). Promotion only ships accept/accept_new_best, never
 *   reject: best_skill.md is only ever written from gate.best_skill, which
 *   only changes on accept_new_best (gate.py:202-217).
 * - `bestScore`/`bestStep` — GateResult fields (gate.py:41-43), persisted by
 *   the original as runtime_state best_score/best_step (trainer.py:1071-1072).
 * - `validationScoreBefore`/`After` — gate-metric-space selection score of the
 *   incumbent before the promoting step and of the accepted candidate after
 *   (runtime_state current_score, trainer.py:1068; candidate score gate.py:39).
 * - `epochs` — completed training steps (runtime_state last_completed_step,
 *   trainer.py:1064).
 * - `l2AvgQuality` — omp-specific: mean L2SampleResult.quality over the real-
 *   execution verification sample; undefined when no sample produced a score.
 */
export interface Provenance {
	skill: string;
	epochs: number;
	validationScoreBefore: number;
	validationScoreAfter: number;
	gateAction: "accept_new_best" | "accept";
	bestScore: number;
	bestStep: number;
	l2AvgQuality: number | undefined;
	promotedAt: string;
}

const PROVENANCE_MARKER = "omp-provenance";
const PROVENANCE_PATTERN = /<!--\s*omp-provenance\s+([\s\S]*?)-->/;

const GATE_ACTION_VALUES = new Set<string>(["accept_new_best", "accept"]);

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/** Structural check so a corrupt or foreign comment never parses as provenance. */
function isProvenance(value: unknown): value is Provenance {
	if (value === null || typeof value !== "object") return false;
	const p = value as Record<string, unknown>;
	return (
		typeof p.skill === "string" &&
		isFiniteNumber(p.epochs) &&
		isFiniteNumber(p.validationScoreBefore) &&
		isFiniteNumber(p.validationScoreAfter) &&
		typeof p.gateAction === "string" &&
		GATE_ACTION_VALUES.has(p.gateAction) &&
		isFiniteNumber(p.bestScore) &&
		isFiniteNumber(p.bestStep) &&
		(p.l2AvgQuality === undefined || isFiniteNumber(p.l2AvgQuality)) &&
		typeof p.promotedAt === "string"
	);
}

/** Serialize provenance into the body-header comment form. */
export function serializeProvenance(provenance: Provenance): string {
	return `<!-- ${PROVENANCE_MARKER} ${JSON.stringify(provenance)} -->`;
}

/**
 * Extract provenance from a promoted skill's content. Tolerant by contract:
 * missing marker, malformed JSON, or wrong shape all yield undefined.
 */
export function readProvenance(content: string): Provenance | undefined {
	const match = PROVENANCE_PATTERN.exec(content);
	if (!match) return undefined;
	try {
		const parsed: unknown = JSON.parse(match[1]);
		return isProvenance(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export interface PromoteSkillInput {
	slug: string;
	description: string;
	/** Skill body WITHOUT the provenance header (it is prepended here). */
	body: string;
	provenance: Provenance;
}

/**
 * Write the promoted skill into the managed-skills directory.
 * Creates `<managed-skills>/<slug>/SKILL.md`, or updates it in place when a
 * previous promotion (or autolearn run) already created it. The 64KB size cap
 * and name sanitization are enforced by `writeManagedSkill` and propagate —
 * an oversize body throws and writes nothing.
 */
export async function promoteSkill(input: PromoteSkillInput): Promise<{ path: string }> {
	const name = sanitizeSkillName(input.slug);
	if (!isProvenance(input.provenance)) {
		throw new Error(`Refusing to promote "${input.slug}" with invalid provenance.`);
	}
	// The slug rides inside an HTML comment: sanitize it too, or a crafted
	// value containing "-->" could terminate the comment early and corrupt
	// the readProvenance round-trip.
	const provenance: Provenance = {
		...input.provenance,
		skill: sanitizeSkillName(input.provenance.skill || input.slug),
	};
	const body = `${serializeProvenance(provenance)}\n${input.body.trim()}`;
	// Existence pre-check only picks the mutation mode; create/update safety
	// (symlinks, hardlinks, exclusivity) is enforced inside writeManagedSkill.
	const file = path.join(getManagedSkillsDir(), name, "SKILL.md");
	const exists = await fs.stat(file).then(
		() => true,
		err => {
			if (isEnoent(err)) return false;
			throw err;
		},
	);
	return writeManagedSkill({
		action: exists ? "update" : "create",
		name,
		description: input.description,
		body,
	});
}
