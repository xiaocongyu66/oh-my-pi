/**
 * Optimizer stage — TS port of SkillOpt reflect → aggregate → select → update
 * edit pipeline (skillopt/optimizer/skill.py + clip.py + gradient/reflect.py).
 *
 * Edit model (skill.py:76-145, types.Edit): `{op, target, content}` where
 * `target` is a VERBATIM substring of the skill document:
 * - append:        add content at document tail (before protected regions)
 * - insert_after:  insert on the line after the first `target` occurrence
 * - replace:       replace first `target` occurrence with content
 * - delete:        remove first `target` occurrence
 * Every application produces a status report (`applied_*` / `skipped_*` /
 * `error`) for the ledger. Text inside `<!-- SLOW_UPDATE_START/END -->` and
 * `<!-- APPENDIX_START/END -->` regions is protected: edits targeting it are
 * skipped, and appends land before the earliest protected region
 * (skill.py:14-58).
 *
 * rankAndSelect (clip.py:25-109) is the "gradient clipping" analog: when the
 * edit pool exceeds the budget (edit_budget = number of edits, the textual
 * learning rate), an extra optimizer call ranks edits by importance; on
 * failure it falls back to order-preserving truncation.
 */
import type { ModelTransport } from "./judge";
import type { Rollout } from "./types";

// ─── Edit model ──────────────────────────────────────────────────────────────

export type EditOpKind = "append" | "insert_after" | "replace" | "delete";

export interface EditOp {
	op: EditOpKind;
	/** Verbatim substring of the current skill (unused by `append`). */
	target: string;
	content: string;
	why: string;
	/** Rough token estimate charged against the content budget. */
	tokens: number;
}

export interface EditReport {
	op: string;
	targetPreview: string;
	contentPreview: string;
	status: string;
}

export const SLOW_UPDATE_START = "<!-- SLOW_UPDATE_START -->";
export const SLOW_UPDATE_END = "<!-- SLOW_UPDATE_END -->";
export const APPENDIX_START = "<!-- APPENDIX_START -->";
export const APPENDIX_END = "<!-- APPENDIX_END -->";

const PROTECTED_REGIONS: readonly [string, string][] = [
	[SLOW_UPDATE_START, SLOW_UPDATE_END],
	[APPENDIX_START, APPENDIX_END],
];

function earliestProtectedStart(skill: string): number {
	const positions = PROTECTED_REGIONS.map(([start]) => skill.indexOf(start)).filter(idx => idx !== -1);
	return positions.length ? Math.min(...positions) : -1;
}

function isInProtectedRegion(skill: string, target: string): boolean {
	if (!target) return false;
	const targetIdx = skill.indexOf(target);
	if (targetIdx === -1) return false;
	for (const [startMarker, endMarker] of PROTECTED_REGIONS) {
		const startIdx = skill.indexOf(startMarker);
		const endIdx = skill.indexOf(endMarker);
		if (startIdx === -1 || endIdx === -1) continue;
		if (startIdx <= targetIdx && targetIdx < endIdx + endMarker.length) return true;
	}
	return false;
}

function stripProtectedMarkers(text: string): string {
	return text
		.replaceAll(SLOW_UPDATE_START, "")
		.replaceAll(SLOW_UPDATE_END, "")
		.replaceAll(APPENDIX_START, "")
		.replaceAll(APPENDIX_END, "");
}

/** Insert content before the earliest protected region, or append at tail. */
function insertBeforeProtected(skill: string, content: string): string {
	const protStart = earliestProtectedStart(skill);
	if (protStart !== -1) {
		const before = skill.slice(0, protStart).trimEnd();
		const after = skill.slice(protStart);
		return `${before}\n\n${content}\n\n${after}`;
	}
	return `${skill.trimEnd()}\n\n${content}\n`;
}

/** skill.py:85-145 — apply one edit, returning a per-edit status report. */
export function applyEditWithReport(skill: string, edit: EditOp): { skill: string; report: EditReport } {
	const content = stripProtectedMarkers(edit.content.trim());
	const target = edit.target;
	const report: EditReport = {
		op: edit.op,
		targetPreview: target.slice(0, 200),
		contentPreview: content.slice(0, 200),
		status: "unknown",
	};

	if (target && isInProtectedRegion(skill, target)) {
		report.status = "skipped_protected_region";
		return { skill, report };
	}

	switch (edit.op) {
		case "append":
			return {
				skill: insertBeforeProtected(skill, content),
				report: {
					...report,
					status:
						earliestProtectedStart(skill) !== -1 ? "applied_append_before_protected_region" : "applied_append",
				},
			};
		case "insert_after": {
			if (!target || !skill.includes(target)) {
				const protStart = earliestProtectedStart(skill);
				const status =
					protStart !== -1
						? "applied_insert_after_fallback_before_protected_region"
						: "applied_insert_after_fallback_append";
				return { skill: insertBeforeProtected(skill, content), report: { ...report, status } };
			}
			const idx = skill.indexOf(target) + target.length;
			const newline = skill.indexOf("\n", idx);
			const insertAt = newline !== -1 ? newline + 1 : skill.length;
			return {
				skill: `${skill.slice(0, insertAt)}\n${content}\n${skill.slice(insertAt)}`,
				report: { ...report, status: "applied_insert_after" },
			};
		}
		case "replace":
			if (!target) {
				return { skill, report: { ...report, status: "skipped_replace_missing_target" } };
			}
			if (!skill.includes(target)) {
				return { skill, report: { ...report, status: "skipped_replace_target_not_found" } };
			}
			// Function replacer: model content is a LITERAL (Python str.replace
			// semantics) — `$&`/`` $` ``/$'/$$ sequences must never expand.
			return { skill: skill.replace(target, () => content), report: { ...report, status: "applied_replace" } };
		case "delete":
			if (!target) {
				return { skill, report: { ...report, status: "skipped_delete_missing_target" } };
			}
			if (!skill.includes(target)) {
				return { skill, report: { ...report, status: "skipped_delete_target_not_found" } };
			}
			return { skill: skill.replace(target, ""), report: { ...report, status: "applied_delete" } };
		default:
			return { skill, report: { ...report, status: "skipped_unknown_op" } };
	}
}

export interface PatchApplyResult {
	text: string;
	reports: (EditReport & { index: number })[];
}

/** skill.py:165-186 — apply edits sequentially with an observability report. */
export function applyPatchWithReport(skill: string, edits: EditOp[]): PatchApplyResult {
	const reports: (EditReport & { index: number })[] = [];
	let current = skill;
	edits.forEach((edit, i) => {
		try {
			const applied = applyEditWithReport(current, edit);
			current = applied.skill;
			reports.push({ ...applied.report, index: i + 1 });
		} catch (err) {
			reports.push({
				index: i + 1,
				op: edit.op,
				targetPreview: edit.target.slice(0, 200),
				contentPreview: "",
				status: "error",
			});
			void err;
		}
	});
	return { text: current, reports };
}

// ─── Proposal parsing (reflect output) ───────────────────────────────────────

export const OPTIMIZER_SYSTEM = [
	"You are a skill optimizer (ReflACT reflect stage). Given a skill document and failed attempts at similar tasks, propose the fewest high-impact edits to the skill.",
	"Rules:",
	'- Reply with STRICT JSON only: {"reasoning": "<one line>", "edits": [{"op": "append|insert_after|replace|delete", "target": "<verbatim text from the skill, empty for append>", "content": "<new text>", "why": "<one line>"}]}',
	"- `target` must be copied EXACTLY (verbatim substring) from the current skill so it can be located.",
	"- Do not repeat previously rejected edits.",
	"- Prefer replacing vague guidance with concrete, checkable steps.",
].join("\n");

export interface ParseEditsLimits {
	/** Textual learning rate: max edits kept (edit_budget in the original). */
	maxEdits: number;
	/** Hard content cap in estimated tokens (defensive, extra to maxEdits). */
	budgetTokens: number;
}

/** Rough token estimate — good enough to bound edit size, not for billing. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

interface RawEdit {
	op?: unknown;
	target?: unknown;
	content?: unknown;
	why?: unknown;
}

const KINDS = new Set<string>(["append", "insert_after", "replace", "delete"]);

/**
 * Parse the optimizer reply into bounded edits. Accepts {"edits":[...]} or a
 * bare array. Malformed elements are dropped (a bad edit must never poison a
 * step); maxEdits is the learning-rate cap, budgetTokens a defensive cap.
 */
export function parseEditOps(reply: string, limits: ParseEditsLimits): EditOp[] {
	const objStart = reply.indexOf("{");
	const arrStart = reply.indexOf("[");
	let items: unknown[] | undefined;
	if (objStart !== -1 && (arrStart === -1 || objStart < arrStart)) {
		const end = reply.lastIndexOf("}");
		if (end > objStart) {
			try {
				const parsed = JSON.parse(reply.slice(objStart, end + 1)) as { edits?: unknown };
				if (Array.isArray(parsed.edits)) items = parsed.edits;
			} catch {
				return [];
			}
		}
	}
	if (!items && arrStart !== -1) {
		const end = reply.lastIndexOf("]");
		if (end > arrStart) {
			try {
				const parsed: unknown = JSON.parse(reply.slice(arrStart, end + 1));
				if (Array.isArray(parsed)) items = parsed;
			} catch {
				return [];
			}
		}
	}
	if (!items) return [];
	const out: EditOp[] = [];
	let usedTokens = 0;
	for (const item of items) {
		if (out.length >= limits.maxEdits) break;
		const e = item as RawEdit;
		if (typeof e?.op !== "string" || !KINDS.has(e.op)) continue;
		const target = typeof e.target === "string" ? e.target : "";
		const content = typeof e.content === "string" ? stripProtectedMarkers(e.content).trim() : "";
		if (e.op !== "append" && e.op !== "delete" && !content) continue;
		if ((e.op === "replace" || e.op === "delete") && !target) continue;
		const tokens = estimateTokens(content || target);
		if (usedTokens + tokens > limits.budgetTokens) break; // budget is a stop, not a filter
		usedTokens += tokens;
		out.push({
			op: e.op as EditOpKind,
			target: target.slice(0, 2000),
			content,
			why: typeof e.why === "string" ? e.why.slice(0, 300) : "",
			tokens,
		});
	}
	return out;
}

/** Ask the optimizer model for this step's proposals (reflect output parse). */
export async function proposeEdits(opts: {
	transport: ModelTransport;
	model: string;
	skill: string;
	lowRollouts: Rollout[];
	rejectedBuffer: string[];
	limits: ParseEditsLimits;
	signal?: AbortSignal;
}): Promise<EditOp[]> {
	const reply = await opts.transport({
		model: opts.model,
		system: OPTIMIZER_SYSTEM,
		prompt: buildOptimizerPrompt({
			skill: opts.skill,
			lowRollouts: opts.lowRollouts,
			rejectedBuffer: opts.rejectedBuffer,
			maxEdits: opts.limits.maxEdits,
		}),
		signal: opts.signal,
	});
	return parseEditOps(reply, opts.limits);
}

export function buildOptimizerPrompt(opts: {
	skill: string;
	lowRollouts: Rollout[];
	rejectedBuffer: string[];
	maxEdits: number;
}): string {
	const lows = opts.lowRollouts
		.map(r => `- task: ${r.taskId}\n  answer: ${r.answer.slice(0, 600)}\n  judge: ${r.score.rationale}`)
		.join("\n");
	const rejected = opts.rejectedBuffer.length
		? `\nPreviously REJECTED edits (do not repeat):\n${opts.rejectedBuffer.join("\n")}`
		: "";
	return [
		`Current skill:`,
		`"""${opts.skill}"""`,
		``,
		`Low-scoring attempts (train set):`,
		lows || "(none)",
		rejected,
		``,
		`Propose at most ${opts.maxEdits} edits. Reply with the JSON object only.`,
	].join("\n");
}

// ─── Select (gradient clipping) ──────────────────────────────────────────────

/**
 * clip.py:25-109 — when the pool exceeds the budget, one extra optimizer call
 * ranks the edits; malformed ranking falls back to order-preserving
 * truncation. Returns the kept edits.
 */
export async function rankAndSelect(opts: {
	transport: ModelTransport;
	model: string;
	skill: string;
	edits: EditOp[];
	maxEdits: number;
	signal?: AbortSignal;
}): Promise<EditOp[]> {
	if (opts.edits.length <= opts.maxEdits) return opts.edits;
	const pool = opts.edits
		.map((e, i) => `[${i}] ${e.op} target=${JSON.stringify(e.target.slice(0, 80))} → ${e.content.slice(0, 120)}`)
		.join("\n");
	try {
		const reply = await opts.transport({
			model: opts.model,
			system:
				'You rank skill edits by expected impact. Reply with STRICT JSON only: {"selected_indices": [<0-based ints in priority order>]}',
			prompt: `## Current Skill\n${opts.skill}\n\n## Edit Pool (${opts.edits.length} edits, budget=${opts.maxEdits})\n${pool}\n\nSelect the ${opts.maxEdits} most important edits. Return their 0-based indices in priority order.`,
			signal: opts.signal,
		});
		const start = reply.indexOf("{");
		const end = reply.lastIndexOf("}");
		if (start !== -1 && end > start) {
			const parsed = JSON.parse(reply.slice(start, end + 1)) as { selected_indices?: unknown };
			if (Array.isArray(parsed.selected_indices)) {
				const selected: EditOp[] = [];
				const seen = new Set<number>();
				for (const idx of parsed.selected_indices) {
					if (
						typeof idx === "number" &&
						Number.isInteger(idx) &&
						idx >= 0 &&
						idx < opts.edits.length &&
						!seen.has(idx)
					) {
						selected.push(opts.edits[idx] as EditOp);
						seen.add(idx);
					}
					if (selected.length >= opts.maxEdits) break;
				}
				if (selected.length) return selected;
			}
		}
	} catch {
		// fall through to truncation (clip.py:101-102)
	}
	return opts.edits.slice(0, opts.maxEdits);
}

// ─── Rollout selection helpers ───────────────────────────────────────────────

/** Pick the rollouts the optimizer should look at: scored, worst first. */
export function selectLowRollouts(rollouts: Rollout[], max: number): Rollout[] {
	return rollouts
		.filter(r => !r.score.abstained && typeof r.score.quality === "number")
		.sort((a, b) => (a.score.quality as number) - (b.score.quality as number))
		.slice(0, max);
}

/** One-line summary stored in the rejection buffer. */
export function editSummary(edit: EditOp): string {
	return `${edit.op} ${JSON.stringify(edit.target.slice(0, 80))}: ${(edit.why || edit.content || "").slice(0, 120)}`;
}
