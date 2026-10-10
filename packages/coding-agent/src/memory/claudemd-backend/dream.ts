/**
 * Dream (memory consolidation) — ported from Claude Code's
 * `src/services/autoDream/{autoDream.ts,config.ts,consolidationLock.ts,consolidationPrompt.ts}`
 * (see /tmp/cc-port-specs/memory.md §6). Lock semantics are a faithful port;
 * the consolidation itself is not.
 *
 * DEVIATION (documented per the porting brief): omp has no forked-agent
 * machinery, so consolidation is ONE injected LLM call. Its input is the
 * full text of MEMORY.md plus every topic file (each capped at 200 lines /
 * 4096 bytes for transport) and the dream prompt's Phase 3/4 guidance
 * verbatim; its output is JSON in the extraction shape plus `{remove: []}`.
 *
 * Other deviations, all deliberate:
 * - The dream prompt's Phase 1/2 bullets that assume CC's KAIROS daily-log
 *   layout and JSONL transcript grepping (`logs/`, `sessions/`,
 *   "Session transcripts:", daily-log priority) are trimmed — omp has no
 *   such directories. Phases 3 and 4 are verbatim.
 * - "Apply" is programmatic here: write `files`, append `index_lines`
 *   (skipping lines already present), delete `remove` files and strip their
 *   index pointers. CC's forked agent edited files directly mid-conversation.
 * - The 5-session gate scans `${agentDir}/sessions` for `.jsonl` transcript
 *   mtimes (omp's
 *   transcript layout) instead of CC's listCandidates UUID validation.
 * - GrowthBook config override (`tengu_onyx_plover`) is stripped — constants
 *   only: 24h / 5 sessions.
 * - The 10-minute session-scan throttle is not ported: with gates this cheap
 *   (one stat + one readdir) and a per-session one-shot auto attempt, the
 *   throttle has nothing to back off from.
 */

import { mkdir, readdir, readFile, stat, unlink, utimes, writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
	DIR_EXISTS_GUIDANCE,
	ENTRYPOINT_NAME,
	MAX_ENTRYPOINT_LINES,
} from "./prompts";
import { claudemdEntrypointPath } from "./prompts";
import { MAX_MEMORY_BYTES, MAX_MEMORY_LINES } from "./recall";
import { applyExtraction, type ExtractionResult, parseExtractionResult } from "./extraction";

// ============================================================================
// Lock (faithful port of consolidationLock.ts)
// ============================================================================

export const LOCK_FILE = ".consolidate-lock";
/** Stale past this even if the PID is live (PID reuse guard). */
export const HOLDER_STALE_MS = 60 * 60 * 1000;

/** Auto-dream gates: constants replacing CC's GB-overridable defaults. */
export const DREAM_MIN_HOURS = 24;
export const DREAM_MIN_SESSIONS = 5;

export function consolidationLockPath(memoryDir: string): string {
	return path.join(memoryDir, LOCK_FILE);
}

/** True when `pid` refers to a live process (ESRCH test). */
export function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but we can't signal it — still running.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * mtime of the lock file = lastConsolidatedAt. 0 if absent.
 * Per-turn cost: one stat.
 */
export async function readLastConsolidatedAt(memoryDir: string): Promise<number> {
	try {
		const s = await stat(consolidationLockPath(memoryDir));
		return s.mtimeMs;
	} catch {
		return 0;
	}
}

/**
 * Acquire: write PID → mtime = now. Returns the pre-acquire mtime
 * (for rollback), or null if blocked / lost a race.
 *
 *   Success → do nothing. mtime stays at now.
 *   Failure → rollbackConsolidationLock(priorMtime) rewinds mtime.
 *   Crash   → mtime stuck, dead PID → next process reclaims.
 */
export async function tryAcquireConsolidationLock(memoryDir: string): Promise<number | null> {
	const path_ = consolidationLockPath(memoryDir);

	let mtimeMs: number | undefined;
	let holderPid: number | undefined;
	try {
		const [s, raw] = await Promise.all([stat(path_), readFile(path_, "utf8")]);
		mtimeMs = s.mtimeMs;
		const parsed = parseInt(raw.trim(), 10);
		holderPid = Number.isFinite(parsed) ? parsed : undefined;
	} catch {
		// ENOENT — no prior lock.
	}

	if (mtimeMs !== undefined && Date.now() - mtimeMs < HOLDER_STALE_MS) {
		if (holderPid !== undefined && isProcessRunning(holderPid)) {
			return null;
		}
		// Dead PID or unparseable body — reclaim.
	}

	// Memory dir may not exist yet.
	await mkdir(memoryDir, { recursive: true });
	await writeFile(path_, String(process.pid));

	// Two reclaimers both write → last wins the PID. Loser bails on re-read.
	let verify: string;
	try {
		verify = await readFile(path_, "utf8");
	} catch {
		return null;
	}
	if (parseInt(verify.trim(), 10) !== process.pid) return null;

	return mtimeMs ?? 0;
}

/**
 * Rewind mtime to pre-acquire after a failed run. Clears the PID body —
 * otherwise our still-running process would look like it's holding.
 * priorMtime 0 → unlink (restore no-file).
 */
export async function rollbackConsolidationLock(memoryDir: string, priorMtime: number): Promise<void> {
	const path_ = consolidationLockPath(memoryDir);
	try {
		if (priorMtime === 0) {
			await unlink(path_);
			return;
		}
		await writeFile(path_, "");
		const t = priorMtime / 1000; // utimes wants seconds
		await utimes(path_, t, t);
	} catch {
		// Rollback is best-effort; failure only delays the next trigger to
		// minHours (the same consequence CC logs and accepts).
	}
}

/**
 * Stamp from manual /dream. Optimistic — best-effort, never throws.
 */
export async function recordConsolidation(memoryDir: string): Promise<void> {
	try {
		await mkdir(memoryDir, { recursive: true });
		await writeFile(consolidationLockPath(memoryDir), String(process.pid));
	} catch {
		// Best-effort.
	}
}

/**
 * Count omp session transcripts (`.jsonl`) touched after `sinceMs` under the
 * project folders of `${agentDir}/sessions`. Undercounting (e.g. XDG-relocated
 * stores) is safe — it's a skip-gate, matching CC's per-cwd scan caveat.
 */
export async function countSessionsTouchedSince(agentDir: string, sinceMs: number): Promise<number> {
	try {
		const sessionsRoot = path.join(agentDir, "sessions");
		const entries = await readdir(sessionsRoot, { recursive: true });
		const jsonl = entries.filter(f => f.endsWith(".jsonl"));
		let count = 0;
		for (const relative of jsonl) {
			try {
				const s = await stat(path.join(sessionsRoot, relative));
				if (s.mtimeMs > sinceMs) count += 1;
			} catch {
				// Vanished between readdir and stat — skip.
			}
		}
		return count;
	} catch {
		return 0;
	}
}

// ============================================================================
// Transport read (topic files capped for the single-call prompt)
// ============================================================================

async function readFileCapped(filePath: string): Promise<string | null> {
	try {
		const text = await readFile(filePath, "utf8");
		const lines = text.split("\n");
		let selected = lines.slice(0, MAX_MEMORY_LINES).join("\n");
		if (selected.length > MAX_MEMORY_BYTES) {
			const cutAt = selected.lastIndexOf("\n", MAX_MEMORY_BYTES);
			selected = selected.slice(0, cutAt > 0 ? cutAt : MAX_MEMORY_BYTES);
			selected += `\n\n> [file truncated for transport (${MAX_MEMORY_BYTES} byte limit)]`;
		}
		return selected;
	} catch {
		return null;
	}
}

export interface DreamContext {
	/** The current MEMORY.md index text ("" when absent). */
	index: string;
	/** One block per topic file: relative name + capped content. */
	files: string[];
}

/**
 * Collect the transport payload for the consolidation call: full MEMORY.md
 * plus every topic file (capped at 200 lines / 4096 bytes each).
 */
export async function collectDreamContext(memoryDir: string, signal?: AbortSignal): Promise<DreamContext> {
	let index = "";
	try {
		index = await readFile(claudemdEntrypointPath(memoryDir), "utf8");
	} catch {
		// No index yet.
	}

	const files: string[] = [];
	if (!signal?.aborted) {
		try {
			const entries = await readdir(memoryDir, { recursive: true });
			const topicFiles = entries
				.filter(f => f.endsWith(".md") && path.basename(f) !== ENTRYPOINT_NAME)
				.sort();
			const contents = await Promise.all(
				topicFiles.map(async relative => {
					const content = await readFileCapped(path.join(memoryDir, relative));
					return content === null ? null : `### ${relative}\n\n${content}`;
				}),
			);
			for (const block of contents) {
				if (block !== null) files.push(block);
			}
		} catch {
			// Dir unreadable — consolidate with whatever we have.
		}
	}

	return { index, files };
}

// ============================================================================
// Prompt (verbatim Phase 3/4; Phase 1/2 trimmed of KAIROS/transcript parts)
// ============================================================================

export function buildConsolidationPrompt(memoryRoot: string, context: DreamContext): string {
	const memoryFilesSection =
		context.files.length > 0
			? context.files.join("\n\n---\n\n")
			: "(no topic files yet)";

	const currentIndexSection =
		context.index.trim().length > 0
			? `### ${ENTRYPOINT_NAME}\n\n${context.index.trim()}`
			: `### ${ENTRYPOINT_NAME}\n\n(empty)`;

	return `# Dream: Memory Consolidation

You are performing a dream — a reflective pass over your memory files. Synthesize what you've learned recently into durable, well-organized memories so that future sessions can orient quickly.

Memory directory: \`${memoryRoot}\`
${DIR_EXISTS_GUIDANCE}

---

## Phase 1 — Orient

The current index and every topic file are included below. Review them so you improve them rather than creating duplicates.

## Phase 2 — Gather recent signal

Look for new information worth persisting. Sources in rough priority order:

1. **Existing memories that drifted** — facts that contradict something you see reflected in the transcript context provided with your system prompt
2. **Gaps** — recent signal the current files don't capture at all

## Phase 3 — Consolidate

For each thing worth remembering, write or update a memory file at the top level of the memory directory. Use the memory file format and type conventions from your system prompt's auto-memory section — it's the source of truth for what to save, how to structure it, and what NOT to save.

Focus on:
- Merging new signal into existing topic files rather than creating near-duplicates
- Converting relative dates ("yesterday", "last week") to absolute dates so they remain interpretable after time passes
- Deleting contradicted facts — if today's investigation disproves an old memory, fix it at the source

## Phase 4 — Prune and index

Update \`${ENTRYPOINT_NAME}\` so it stays under ${MAX_ENTRYPOINT_LINES} lines AND under ~25KB. It's an **index**, not a dump — each entry should be one line under ~150 characters: \`- [Title](file.md) — one-line hook\`. Never write memory content directly into it.

- Remove pointers to memories that are now stale, wrong, or superseded
- Demote verbose entries: if an index line is over ~200 chars, it's carrying content that belongs in the topic file — shorten the line, move the detail
- Add pointers to newly important memories
- Resolve contradictions — if two files disagree, fix the wrong one

---

## Output format

Respond with ONLY a JSON object — no prose before or after, no code fences:

{"files": [{"filename": "topic_name.md", "content": "full memory file content including frontmatter"}], "index_lines": ["- [Title](topic_name.md) — one-line hook"], "remove": ["stale_topic.md"], "summary": "one-paragraph summary of what changed"}

- \`filename\` must be a bare \`.md\` filename (no directories); it must never be \`${ENTRYPOINT_NAME}\`
- \`remove\` lists topic files to delete outright; their index pointers are dropped automatically
- Return empty arrays (and a summary saying so) when memories are already tight

---

## Current memory files

${currentIndexSection}

${memoryFilesSection}`;
}

// ============================================================================
// Result parsing (extraction shape + remove)
// ============================================================================

export interface DreamResult extends ExtractionResult {
	remove: string[];
	summary: string;
}

/** Strip a ```json fenced wrapper if the model emitted one. */
function stripCodeFence(text: string): string {
	if (text.startsWith("```")) {
		const firstNewline = text.indexOf("\n");
		if (firstNewline !== -1) {
			const lastFence = text.lastIndexOf("```");
			if (lastFence > firstNewline) {
				return text.slice(firstNewline + 1, lastFence).trim();
			}
		}
	}
	return text;
}

/**
 * Parse and validate the consolidation output: extraction shape (bad
 * filenames / empty content / insane frontmatter dropped by the shared
 * validator) plus `remove` (bare .md filenames, never MEMORY.md) and an
 * optional `summary`. Returns null for unparseable output.
 */
export function parseDreamResult(text: string): DreamResult | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripCodeFence(text.trim()));
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const record = parsed as Record<string, unknown>;

	const base = parseExtractionResult(text);
	if (base === null) return null;

	const remove: string[] = [];
	const rawRemove = Array.isArray(record.remove) ? record.remove : [];
	for (const raw of rawRemove) {
		if (typeof raw !== "string") continue;
		const filename = raw.trim();
		// Same safety contract as topic filenames, applied to deletions.
		if (filename.toLowerCase().endsWith(".md") && !filename.includes("/") && !filename.includes("\\")) {
			const base_ = path.basename(filename);
			if (base_ !== ENTRYPOINT_NAME && base_.toLowerCase() !== "memory.md" && !base_.startsWith(".")) {
				remove.push(base_);
			}
		}
	}

	const summary = typeof record.summary === "string" ? record.summary : "";
	return { ...base, remove, summary };
}

// ============================================================================
// Apply
// ============================================================================

export interface AppliedDream {
	written: string[];
	removed: string[];
	indexAppended: number;
	indexPointerRemoved: number;
}

/**
 * Apply a validated consolidation: write/update topic files, delete removed
 * topic files (dropping their index pointers), then append new index lines.
 */
export async function applyDream(memoryDir: string, result: DreamResult): Promise<AppliedDream> {
	await mkdir(memoryDir, { recursive: true });

	const removed: string[] = [];
	for (const filename of result.remove) {
		try {
			await unlink(path.join(memoryDir, filename));
			removed.push(filename);
		} catch {
			// Already gone or never existed — nothing to do.
		}
	}

	let indexAppended = 0;
	let indexPointerRemoved = 0;
	const entrypointPath = claudemdEntrypointPath(memoryDir);
	if (removed.length > 0 || result.indexLines.length > 0) {
		let existing = "";
		try {
			existing = await readFile(entrypointPath, "utf8");
		} catch {
			// No index yet.
		}
		let lines = existing.split("\n");
		if (removed.length > 0) {
			const removedSet = new Set(removed);
			const filtered = lines.filter(line => {
				if (!line.trim()) return true;
				const pointsAtRemoved = [...removedSet].some(name => line.includes(`](${name})`));
				if (pointsAtRemoved) indexPointerRemoved += 1;
				return !pointsAtRemoved;
			});
			lines = filtered;
		}
		let current = lines.join("\n");
		const existingLines = new Set(current.split("\n").map(l => l.trim()));
		const additions = result.indexLines.filter(l => !existingLines.has(l.trim()));
		if (additions.length > 0) {
			const prefix = current.length > 0 && !current.endsWith("\n") ? `${current}\n` : current;
			current = prefix + additions.join("\n") + "\n";
			indexAppended = additions.length;
		}
		await writeFile(entrypointPath, current, "utf8");
	}

	const applied = await applyExtraction(memoryDir, { files: result.files, indexLines: [] });
	return { written: applied.written, removed, indexAppended, indexPointerRemoved };
}
