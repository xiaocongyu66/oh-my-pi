/**
 * Recall (relevant-memory selection + surfacing) — ported from Claude Code's
 * `src/memdir/findRelevantMemories.ts` and the injection side of
 * `src/utils/attachments.ts` + `src/memdir/memoryAge.ts`
 * (see /tmp/cc-port-specs/memory.md §4).
 *
 * Deviations from CC:
 * - "Claude Code" in the selector system prompt is replaced with "the agent"
 *   (the model consuming these memories is omp, not Claude Code); all other
 *   wording is verbatim.
 * - The sideQuery/Sonnet machinery is replaced by an injected `select` seam:
 *   `select(query, manifest, tools, signal): Promise<string>` returning raw
 *   JSON text, parsed here into `{selected_memories: string[]}`. The default
 *   seam (backend.ts) wraps pi-ai `completeSimple` with the session model.
 * - MEMORY_SHAPE_TELEMETRY (fires even on empty selection) is stripped.
 * - The `readFileState` filter (files the main model already read via the
 *   Read tool) is not ported — omp has no cross-cutting read-state registry
 *   to consult here; `alreadySurfaced` still dedupes against prior injections.
 * - Surfacing here appends to a system-prompt section (one
 *   `<system-reminder>` block) instead of CC's per-memory user messages.
 */

import { readFile } from "node:fs/promises";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { formatMemoryManifest, scanMemorySources, type MemoryHeader } from "./scan";
import type { MemorySource } from "./paths";

export interface RelevantMemory {
	path: string;
	mtimeMs: number;
}

/**
 * Selector LLM system prompt — verbatim from CC findRelevantMemories.ts
 * except "Claude Code" → "the agent" (three occurrences).
 */
export const SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will be useful to the agent as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a list of filenames for the memories that will clearly be useful to the agent as it processes the user's query (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free to return an empty list.
- If a list of recently-used tools is provided, do not select memories that are usage reference or API documentation for those tools (the agent is already exercising them). DO still select memories containing warnings, gotchas, or known issues about those tools — active use is exactly when those matter.
`;

/** Max memories selected per recall. */
export const MAX_SELECTED_MEMORIES = 5;

/** Injection truncation caps (attachments.ts MAX_MEMORY_LINES/MAX_MEMORY_BYTES). */
export const MAX_MEMORY_LINES = 200;
export const MAX_MEMORY_BYTES = 4096;

/** Cumulative per-session injection budget (attachments.ts RELEVANT_MEMORIES_CONFIG). */
export const MAX_SESSION_BYTES = 60 * 1024;

/** Selector result schema key, verbatim from CC. */
const SELECTED_MEMORIES_KEY = "selected_memories";

/**
 * Selector user-message template — verbatim from CC selectRelevantMemories
 * (shared by the recall seam adapter and findRelevantMemories itself).
 */
export function formatSelectorUserPrompt(query: string, manifest: string, recentTools: readonly string[]): string {
	// When the agent is actively using a tool (e.g. mcp__X__spawn), surfacing
	// that tool's reference docs is noise — the conversation already contains
	// working usage. The selector otherwise matches on keyword overlap.
	const toolsSection = recentTools.length > 0 ? `\n\nRecently used tools: ${recentTools.join(", ")}` : "";
	return `Query: ${query}\n\nAvailable memories:\n${manifest}${toolsSection}`;
}

/**
 * The selector LLM seam. Returns the raw model text; the caller parses
 * `{selected_memories: string[]}` out of it (tests fake this directly).
 */
export type SelectMemoriesFn = (
	query: string,
	manifest: string,
	recentTools: readonly string[],
	signal?: AbortSignal,
) => Promise<string>;

/**
 * Parse the selector model output into filenames. Non-JSON, missing array,
 * or non-string entries yield an empty selection (recall is best-effort).
 */
export function parseSelectorResponse(text: string): string[] {
	try {
		const jsonText = stripCodeFence(text.trim());
		const parsed: unknown = JSON.parse(jsonText);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
		const selected = (parsed as Record<string, unknown>)[SELECTED_MEMORIES_KEY];
		if (!Array.isArray(selected)) return [];
		return selected.filter((f): f is string => typeof f === "string");
	} catch {
		return [];
	}
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
 * Find memory files relevant to a query by scanning memory file headers and
 * asking the selector to pick the most relevant ones (up to 5). Excludes
 * MEMORY.md (already loaded in the system prompt) and `alreadySurfaced`
 * paths. Hallucinated filenames (not in the candidate set) are filtered.
 * Errors are swallowed — recall is best-effort and returns [].
 */
export async function findRelevantMemories(options: {
	query: string;
	sources: readonly MemorySource[];
	select: SelectMemoriesFn;
	signal?: AbortSignal;
	recentTools?: readonly string[];
	alreadySurfaced?: ReadonlySet<string>;
}): Promise<RelevantMemory[]> {
	const { query, sources, select, signal } = options;
	const alreadySurfaced = options.alreadySurfaced ?? new Set<string>();
	try {
		const memories = (await scanMemorySources(sources, signal)).filter(m => !alreadySurfaced.has(m.filePath));
		// Empty candidate list → no model call.
		if (memories.length === 0) {
			return [];
		}

		const selectedFilenames = await selectRelevantMemories({
			query,
			memories,
			select,
			signal,
			recentTools: options.recentTools ?? [],
		});
		const byFilename = new Map(memories.map(m => [m.filename, m]));
		return selectedFilenames
			.map(filename => byFilename.get(filename))
			.filter((m): m is MemoryHeader => m !== undefined)
			.slice(0, MAX_SELECTED_MEMORIES)
			.map(m => ({ path: m.filePath, mtimeMs: m.mtimeMs }));
	} catch {
		if (signal?.aborted) return [];
		return [];
	}
}

async function selectRelevantMemories(options: {
	query: string;
	memories: MemoryHeader[];
	select: SelectMemoriesFn;
	signal?: AbortSignal;
	recentTools: readonly string[];
}): Promise<string[]> {
	const { query, memories, select, signal, recentTools } = options;
	const validFilenames = new Set(memories.map(m => m.filename));
	const manifest = formatMemoryManifest(memories);

	try {
		const responseText = await select(query, manifest, recentTools, signal);
		if (signal?.aborted) return [];
		return parseSelectorResponse(responseText).filter(f => validFilenames.has(f));
	} catch {
		return [];
	}
}

// ============================================================================
// Memory age helpers (verbatim port of memoryAge.ts)
// ============================================================================

/** Days elapsed since mtime. Floor-rounded; negative inputs clamp to 0. */
export function memoryAgeDays(mtimeMs: number): number {
	return Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000));
}

/** Human-readable age string ("today" / "yesterday" / "N days ago"). */
export function memoryAge(mtimeMs: number): string {
	const d = memoryAgeDays(mtimeMs);
	if (d === 0) return "today";
	if (d === 1) return "yesterday";
	return `${d} days ago`;
}

/**
 * Plain-text staleness caveat for memories >1 day old. Returns "" for fresh
 * (today/yesterday) memories — warning there is noise.
 */
export function memoryFreshnessText(mtimeMs: number): string {
	const d = memoryAgeDays(mtimeMs);
	if (d <= 1) return "";
	return (
		`This memory is ${d} days old. ` +
		`Memories are point-in-time observations, not live state — ` +
		`claims about code behavior or file:line citations may be outdated. ` +
		`Verify against current code before asserting as fact.`
	);
}

/**
 * Header string for a relevant-memory block (verbatim port from
 * attachments.ts memoryHeader).
 */
export function memoryHeader(filePath: string, mtimeMs: number): string {
	const staleness = memoryFreshnessText(mtimeMs);
	return staleness ? `${staleness}\n\nMemory: ${filePath}:` : `Memory (saved ${memoryAge(mtimeMs)}): ${filePath}:`;
}

// ============================================================================
// Surfacing read (port of attachments.ts readMemoriesForSurfacing)
// ============================================================================

export interface SurfacedMemory {
	path: string;
	content: string;
	mtimeMs: number;
	header: string;
	/** UTF-16 code units of content — feeds the per-session byte budget. */
	byteCount: number;
}

/**
 * Read whole-file stats + the first `maxLines` lines of a memory file in one
 * pass (replaces CC's readFileInRange fast path). Never throws.
 */
async function readMemoryFileForSurfacing(
	filePath: string,
	signal?: AbortSignal,
): Promise<{ content: string; totalLines: number; truncatedByBytes: boolean } | null> {
	try {
		if (signal?.aborted) return null;
		const text = await readFile(filePath, "utf8");
		const lines = text.split("\n");
		const totalLines = lines.length;
		let selected = lines.slice(0, MAX_MEMORY_LINES).join("\n");
		let truncatedByBytes = false;
		if (selected.length > MAX_MEMORY_BYTES) {
			// Stop at the last complete line that fits; never cut mid-line.
			const cutAt = selected.lastIndexOf("\n", MAX_MEMORY_BYTES);
			selected = selected.slice(0, cutAt > 0 ? cutAt : MAX_MEMORY_BYTES);
			truncatedByBytes = true;
		}
		return { content: selected, totalLines, truncatedByBytes };
	} catch {
		return null;
	}
}

/**
 * Read a set of relevance-ranked memory files for injection. Enforces both
 * MAX_MEMORY_LINES and MAX_MEMORY_BYTES; truncation appends a note (verbatim
 * from CC) rather than dropping the file — the frontmatter + opening context
 * is usually what matters. Unreadable files are dropped.
 */
export async function readMemoriesForSurfacing(
	selected: ReadonlyArray<RelevantMemory>,
	signal?: AbortSignal,
): Promise<SurfacedMemory[]> {
	const results = await Promise.all(
		selected.map(async ({ path: filePath, mtimeMs }) => {
			const result = await readMemoryFileForSurfacing(filePath, signal);
			if (!result) return null;
			const truncated = result.totalLines > MAX_MEMORY_LINES || result.truncatedByBytes;
			const content = truncated
				? result.content +
					`\n\n> This memory file was truncated (${result.truncatedByBytes ? `${MAX_MEMORY_BYTES} byte limit` : `first ${MAX_MEMORY_LINES} lines`}). Use the Read tool to view the complete file at: ${filePath}`
				: result.content;
			return {
				path: filePath,
				content,
				mtimeMs,
				header: memoryHeader(filePath, mtimeMs),
				byteCount: content.length,
			};
		}),
	);
	return results.filter(r => r !== null);
}

/**
 * Render surfaced memories as the injected system-prompt block: each memory
 * as its header + content, wrapped in one <system-reminder> (CC wraps each
 * memory in its own user message; omp injects a single system-prompt section).
 */
export function formatMemoryInjection(memories: ReadonlyArray<SurfacedMemory>): string {
	const body = memories.map(m => `${m.header}\n\n${m.content}`).join("\n\n");
	return `<system-reminder>\n## Relevant memories\n\n${body}\n</system-reminder>`;
}

// ============================================================================
// Recent successful tools (port of attachments.ts collectRecentSuccessfulTools)
// ============================================================================

/**
 * Backward scan from the last message down to the last user turn (inclusive
 * boundary): a tool is included only if it has at least one successful
 * tool_result and zero error results in that window. omp tool results are
 * standalone messages, so the scan stops at the first user message.
 */
export function collectRecentSuccessfulTools(messages: readonly AgentMessage[]): string[] {
	let lastUserIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]!.role === "user") {
			lastUserIndex = i;
			break;
		}
	}
	if (lastUserIndex === -1) return [];

	const counts = new Map<string, { ok: number; error: number }>();
	for (let i = messages.length - 1; i >= lastUserIndex; i--) {
		const message = messages[i]!;
		if (message.role !== "toolResult") continue;
		const entry = counts.get(message.toolName) ?? { ok: 0, error: 0 };
		if (message.isError) entry.error += 1;
		else entry.ok += 1;
		counts.set(message.toolName, entry);
	}
	return [...counts.entries()]
		.filter(([, c]) => c.ok > 0 && c.error === 0)
		.map(([name]) => name)
		.sort();
}
