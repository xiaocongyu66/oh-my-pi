/**
 * Prompt sections and builders for the `claudemd` memory backend — ported
 * from Claude Code's `src/memdir/memdir.ts` + `src/memdir/memoryTypes.ts`
 * (see /tmp/cc-port-specs/memory.md §2). All instruction sections are
 * verbatim from the CC source; deviations are listed here:
 *
 * - TEAMMEM combined-mode text (`TYPES_SECTION_COMBINED`, `DIRS_EXIST_GUIDANCE`,
 *   team/private scope tags) is stripped — single-directory mode only.
 * - The "Searching past context" section (GB `tengu_coral_fern`) is not ported.
 * - `buildMemoryLines` drops the `skipIndex` variant and `extraGuidelines`
 *   parameter (always the indexed two-step form; no Cowork env plumbing).
 * - `DIR_EXISTS_GUIDANCE` names THIS agent's Write/Edit tools (omp's tools
 *   are `write`/`edit`) instead of Claude Code's Write tool.
 * - `truncateEntrypointContent` measures "bytes" as UTF-16 code units
 *   (`trimmed.length`), exactly like CC — the cap constant is named BYTES
 *   for fidelity even though it counts code units.
 */

import * as path from "node:path";

// ============================================================================
// Constants (verbatim from CC unless noted)
// ============================================================================

export const ENTRYPOINT_NAME = "MEMORY.md";
export const MAX_ENTRYPOINT_LINES = 200;
// ~125 chars/line at 200 lines. At p97 today; catches long-line indexes that
// slip past the line cap (p100 observed: 197KB under 200 lines).
// NOTE: measured as UTF-16 code units (`string.length`), not real bytes —
// same caveat as the CC original.
export const MAX_ENTRYPOINT_BYTES = 25_000;

/**
 * Shared guidance text appended to each memory directory prompt line.
 * Shipped because the model was burning turns on `ls`/`mkdir -p` before
 * writing. The harness pre-creates the directory via `ensureMemoryDirExists`.
 * Adapted from CC: names this agent's Write/Edit tools.
 */
export const DIR_EXISTS_GUIDANCE =
	"This directory already exists — write to it directly with the Write/Edit tools (do not run mkdir or check for its existence).";

const AUTO_MEM_DISPLAY_NAME = "auto memory";

// ============================================================================
// Memory type taxonomy (verbatim from memoryTypes.ts)
// ============================================================================

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

/**
 * Parse a raw frontmatter value into a MemoryType.
 * Invalid or missing values return undefined — legacy files without a
 * `type:` field keep working, files with unknown types degrade gracefully.
 */
export function parseMemoryType(raw: unknown): MemoryType | undefined {
	if (typeof raw !== "string") return undefined;
	return MEMORY_TYPES.find(t => t === raw);
}

/**
 * `## Types of memory` section for INDIVIDUAL-ONLY mode (single directory).
 * No <scope> tags. Verbatim.
 */
export const TYPES_SECTION_INDIVIDUAL: readonly string[] = [
	"## Types of memory",
	"",
	"<types>",
	"<type>",
	"    <name>user</name>",
	"    <description>The user's role, goals, preferences, responsibilities, and knowledge. Use these to tailor your behavior to the user.</description>",
	"</type>",
	"<type>",
	"    <name>feedback</name>",
	"    <description>Guidance from the user about how to approach work — what to avoid and what to keep doing. Record from failure AND success. Include *why* so you can judge edge cases later. Structure content as: rule/fact, then **Why:** and **How to apply:** lines.</description>",
	"</type>",
	"<type>",
	"    <name>project</name>",
	'    <description>Information about ongoing work, goals, initiatives, bugs, or incidents not derivable from code or git history. Convert relative dates to absolute dates when saving (e.g., "Thursday" → "2026-03-05").</description>',
	"</type>",
	"<type>",
	"    <name>reference</name>",
	"    <description>Pointers to external systems where information can be found (e.g., Linear projects, Slack channels, Grafana dashboards).</description>",
	"</type>",
	"</types>",
	"",
];

/**
 * `## What NOT to save in memory` section. Verbatim.
 */
export const WHAT_NOT_TO_SAVE_SECTION: readonly string[] = [
	"## What NOT to save in memory",
	"",
	"- Code patterns, conventions, architecture, file paths, or project structure — these can be derived by reading the current project state.",
	"- Git history, recent changes, or who-changed-what — `git log` / `git blame` are authoritative.",
	"- Debugging solutions or fix recipes — the fix is in the code; the commit message has the context.",
	"- Anything already documented in CLAUDE.md files.",
	"- Ephemeral task details: in-progress work, temporary state, current conversation context.",
	"",
	// H2: explicit-save gate. Eval-validated (memory-prompt-iteration case 3,
	// 0/2 → 3/3): prevents "save this week's PR list" → activity-log noise.
	"These exclusions apply even when the user explicitly asks you to save. If they ask you to save a PR list or activity summary, ask what was *surprising* or *non-obvious* about it — that is the part worth keeping.",
];

/**
 * Recall-side drift caveat. Single bullet under `## When to access memories`.
 * Verbatim.
 */
export const MEMORY_DRIFT_CAVEAT =
	"- Memory records can become stale over time. Use memory as context for what was true at a given point in time. Before answering the user or building assumptions based solely on information in memory records, verify that the memory is still correct and up-to-date by reading the current state of the files or resources. If a recalled memory conflicts with current information, trust what you observe now — and update or remove the stale memory rather than acting on it.";

/**
 * `## When to access memories` section. Includes MEMORY_DRIFT_CAVEAT. Verbatim.
 */
export const WHEN_TO_ACCESS_SECTION: readonly string[] = [
	"## When to access memories",
	"- When memories seem relevant, or the user references prior-conversation work.",
	"- You MUST access memory when the user explicitly asks you to check, recall, or remember.",
	"- If the user says to *ignore* or *not use* memory: proceed as if MEMORY.md were empty. Do not apply remembered facts, cite, compare against, or mention memory content.",
	MEMORY_DRIFT_CAVEAT,
];

/**
 * `## Before recommending from memory` section. Header wording is eval-tuned
 * in CC — do not reword. Verbatim.
 */
export const TRUSTING_RECALL_SECTION: readonly string[] = [
	"## Before recommending from memory",
	"",
	"A memory that names a specific function, file, or flag is a claim that it existed *when the memory was written*. It may have been renamed, removed, or never merged. Before recommending it:",
	"",
	"- If the memory names a file path: check the file exists.",
	"- If the memory names a function or flag: grep for it.",
	"- If the user is about to act on your recommendation (not just asking about history), verify first.",
	"",
	'"The memory says X exists" is not the same as "X exists now."',
	"",
	"A memory that summarizes repo state (activity logs, architecture snapshots) is frozen in time. If the user asks about *recent* or *current* state, prefer `git log` or reading the code over recalling the snapshot.",
];

/**
 * Frontmatter format example with the `type` field. Verbatim.
 */
export const MEMORY_FRONTMATTER_EXAMPLE: readonly string[] = [
	"```markdown",
	"---",
	"name: {{memory name}}",
	"description: {{one-line description — used to decide relevance in future conversations, so be specific}}",
	`type: {{${MEMORY_TYPES.join(", ")}}}`,
	"---",
	"",
	"{{memory content — for feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines}}",
	"```",
];

// ============================================================================
// Entrypoint truncation (verbatim port of memdir.ts truncateEntrypointContent)
// ============================================================================

export interface EntrypointTruncation {
	content: string;
	lineCount: number;
	byteCount: number;
	wasLineTruncated: boolean;
	wasByteTruncated: boolean;
}

/**
 * Truncate MEMORY.md content to the line AND byte caps, appending a warning
 * that names which cap fired. Line-truncates first (natural boundary), then
 * byte-truncates at the last newline before the cap so we don't cut mid-line.
 *
 * "Bytes" here are UTF-16 code units (`trimmed.length`), matching the CC
 * original's `formatFileSize`-formatted measurement.
 */
export function truncateEntrypointContent(raw: string): EntrypointTruncation {
	const trimmed = raw.trim();
	const contentLines = trimmed.split("\n");
	const lineCount = contentLines.length;
	const byteCount = trimmed.length;

	const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES;
	// Check original byte count — long lines are the failure mode the byte cap
	// targets, so post-line-truncation size would understate the warning.
	const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES;

	if (!wasLineTruncated && !wasByteTruncated) {
		return { content: trimmed, lineCount, byteCount, wasLineTruncated, wasByteTruncated };
	}

	let truncated = wasLineTruncated ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join("\n") : trimmed;

	if (truncated.length > MAX_ENTRYPOINT_BYTES) {
		const cutAt = truncated.lastIndexOf("\n", MAX_ENTRYPOINT_BYTES);
		truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES);
	}

	const reason =
		wasByteTruncated && !wasLineTruncated
			? `${formatFileSize(byteCount)} (limit: ${formatFileSize(MAX_ENTRYPOINT_BYTES)}) — index entries are too long`
			: wasLineTruncated && !wasByteTruncated
				? `${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`
				: `${lineCount} lines and ${formatFileSize(byteCount)}`;

	return {
		content:
			truncated +
			`\n\n> WARNING: ${ENTRYPOINT_NAME} is ${reason}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`,
		lineCount,
		byteCount,
		wasLineTruncated,
		wasByteTruncated,
	};
}

/** Ported verbatim from CC `src/utils/format.ts` (used by the truncation warning). */
export function formatFileSize(sizeInBytes: number): string {
	const kb = sizeInBytes / 1024;
	if (kb < 1) {
		return `${sizeInBytes} bytes`;
	}
	if (kb < 1024) {
		return `${kb.toFixed(1).replace(/\.0$/, "")}KB`;
	}
	const mb = kb / 1024;
	if (mb < 1024) {
		return `${mb.toFixed(1).replace(/\.0$/, "")}MB`;
	}
	const gb = mb / 1024;
	return `${gb.toFixed(1).replace(/\.0$/, "")}GB`;
}

// ============================================================================
// Developer-instruction builders (port of buildMemoryLines + buildMemoryPrompt)
// ============================================================================

/**
 * Build the typed-memory behavioral instructions (without MEMORY.md content).
 * Indexed two-step `howToSave` variant only — CC's `skipIndex` mode
 * (GB `tengu_moth_copse`) is not ported.
 */
export function buildMemoryLines(displayName: string, memoryDir: string): string[] {
	const howToSave = [
		"## How to save memories",
		"",
		"Saving a memory is a two-step process:",
		"",
		"**Step 1** — write the memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:",
		"",
		...MEMORY_FRONTMATTER_EXAMPLE,
		"",
		`**Step 2** — add a pointer to that file in \`${ENTRYPOINT_NAME}\`. \`${ENTRYPOINT_NAME}\` is an index, not a memory — each entry should be one line, under ~150 characters: \`- [Title](file.md) — one-line hook\`. It has no frontmatter. Never write memory content directly into \`${ENTRYPOINT_NAME}\`.`,
		"",
		`- \`${ENTRYPOINT_NAME}\` is always loaded into your conversation context — lines after ${MAX_ENTRYPOINT_LINES} will be truncated, so keep the index concise`,
		"- Keep the name, description, and type fields in memory files up-to-date with the content",
		"- Organize memory semantically by topic, not chronologically",
		"- Update or remove memories that turn out to be wrong or outdated",
		"- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.",
	];

	return [
		`# ${displayName}`,
		"",
		`You have a persistent, file-based memory system at \`${memoryDir}\`. ${DIR_EXISTS_GUIDANCE}`,
		"",
		"You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.",
		"",
		"If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.",
		"",
		...TYPES_SECTION_INDIVIDUAL,
		...WHAT_NOT_TO_SAVE_SECTION,
		"",
		...howToSave,
		"",
		...WHEN_TO_ACCESS_SECTION,
		"",
		...TRUSTING_RECALL_SECTION,
		"",
		"## Memory and other forms of persistence",
		"Memory is one of several persistence mechanisms available to you as you assist the user in a given conversation. The distinction is often that memory can be recalled in future conversations and should not be used for persisting information that is only useful within the scope of the current conversation.",
		"- When to use or update a plan instead of memory: If you are about to start a non-trivial implementation task and would like to reach alignment with the user on your approach you should use a Plan rather than saving this information to memory. Similarly, if you already have a plan within the conversation and you have changed your approach persist that change by updating the plan rather than saving a memory.",
		"- When to use or update tasks instead of memory: When you need to break your work in current conversation into discrete steps or keep track of your progress use tasks instead of saving to memory. Tasks are great for persisting information about the work that needs to be done in the current conversation, but memory should be reserved for information that will be useful in future conversations.",
		"",
	];
}

/**
 * Build the full developer-instruction prompt: instruction lines plus the
 * `## MEMORY.md` section with entrypoint content (truncated) or the
 * empty-index line. Port of buildMemoryPrompt minus telemetry/sync-read
 * (entrypoint content is passed in by the caller, which reads it async).
 */
export function buildClaudeMdDeveloperInstructions(memoryDir: string, entrypointContent: string): string {
	const lines = buildMemoryLines(AUTO_MEM_DISPLAY_NAME, memoryDir);
	if (entrypointContent.trim()) {
		const t = truncateEntrypointContent(entrypointContent);
		lines.push(`## ${ENTRYPOINT_NAME}`, "", t.content);
	} else {
		lines.push(
			`## ${ENTRYPOINT_NAME}`,
			"",
			`Your ${ENTRYPOINT_NAME} is currently empty. When you save new memories, they will appear here.`,
		);
	}
	return lines.join("\n");
}

// ============================================================================
// Paths
// ============================================================================

/** Memory directory for this backend: `${agentDir}/memory/` (no trailing sep). */
export function claudemdMemoryDir(agentDir: string): string {
	return path.join(agentDir, "memory");
}

/** Entrypoint path inside the memory dir. */
export function claudemdEntrypointPath(memoryDir: string): string {
	return path.join(memoryDir, ENTRYPOINT_NAME);
}

/**
 * Path-containment check mirroring CC `isAutoMemPath`: normalized absolute
 * path must be the dir itself or inside it (dir has no trailing separator,
 * so compare against dir + path.sep explicitly).
 */
export function isClaudeMdPath(memoryDir: string, absolutePath: string): boolean {
	const normalized = path.normalize(absolutePath);
	return normalized === memoryDir || normalized.startsWith(memoryDir + path.sep);
}
