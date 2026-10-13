/**
 * Turn-end memory extraction — ported from Claude Code's
 * `src/services/extractMemories/{extractMemories.ts,prompts.ts}`
 * (see /tmp/cc-port-specs/memory.md §5).
 *
 * DEVIATION (documented per the porting brief): omp has no forked-agent
 * machinery, so extraction is ONE injected LLM call instead of a 5-turn
 * subagent with file tools. The call receives the serialized recent
 * messages (role + text of the last user/assistant messages since the
 * turn watermark) plus the existing memory-file manifest, and returns JSON
 * `{files: [{filename, content}], index_lines: [string]}` which this module
 * validates and applies (write topic files, append index lines).
 *
 * Consequences, all deliberate:
 * - The opener's tool-list / turn-budget paragraphs are replaced by the JSON
 *   output contract; the "analyze the most recent ~N messages" and
 *   "MUST only use content from the last ~N messages" paragraphs are kept
 *   verbatim modulo "above" → "below".
 * - The extraction-variant `howToSave` (with the "system prompt" wording and
 *   without the "Keep the name..." bullet) is verbatim except Step 1/Step 2
 *   now describe emitting `files`/`index_lines` entries instead of calling
 *   Write/Edit.
 * - The current MEMORY.md index is included in the prompt (CC's fork could
 *   read it directly) and `index_lines` that already exist verbatim in the
 *   index are skipped on apply, to keep the append-only model from bloating
 *   the index across turns.
 * - `hasMemoryWritesSince` mutual exclusion (CC skips extraction when the
 *   main agent wrote memories itself) is not ported: this backend does not
 *   intercept the main agent's file writes; the developer instructions
 *   already tell the agent to update memories directly.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	claudemdEntrypointPath,
	ENTRYPOINT_NAME,
	MEMORY_FRONTMATTER_EXAMPLE,
	parseMemoryType,
	TYPES_SECTION_INDIVIDUAL,
	WHAT_NOT_TO_SAVE_SECTION,
} from "./prompts";

/** Cap on serialized messages per extraction call (prompt-size guard). */
export const MAX_EXTRACTION_MESSAGES = 40;
/** Cap on topic files written per extraction (mirrors CC's maxTurns budget). */
export const MAX_EXTRACTION_FILES = 5;
/** Cap on index lines appended per extraction. */
export const MAX_EXTRACTION_INDEX_LINES = 50;

// ============================================================================
// Prompt (auto-only variant of buildExtractAutoOnlyPrompt, adapted)
// ============================================================================

export function buildExtractionPrompt(options: {
	newMessageCount: number;
	existingMemories: string;
	currentIndex: string;
}): string {
	const manifest =
		options.existingMemories.length > 0
			? `\n\n## Existing memory files\n\n${options.existingMemories}\n\nCheck this list before writing — update an existing file rather than creating a duplicate.`
			: "";

	const currentIndexSection =
		options.currentIndex.trim().length > 0
			? `\n\n## Current ${ENTRYPOINT_NAME} index\n\n${options.currentIndex.trim()}\n\nOnly return \`index_lines\` entries that are NOT already in the index above.`
			: "";

	const howToSave = [
		"## How to save memories",
		"",
		"Saving a memory is a two-step process:",
		"",
		"**Step 1** — emit the memory as one entry of your `files` array (`filename` like `user_role.md`, `feedback_testing.md`) using this frontmatter format:",
		"",
		...MEMORY_FRONTMATTER_EXAMPLE,
		"",
		`**Step 2** — add a pointer to that file by returning one line in your \`index_lines\` array for \`${ENTRYPOINT_NAME}\`. \`${ENTRYPOINT_NAME}\` is an index, not a memory — each entry should be one line, under ~150 characters: \`- [Title](file.md) — one-line hook\`. It has no frontmatter. Never write memory content directly into \`${ENTRYPOINT_NAME}\`.`,
		"",
		`- \`${ENTRYPOINT_NAME}\` is always loaded into your system prompt — lines after 200 will be truncated, so keep the index concise`,
		"- Organize memory semantically by topic, not chronologically",
		"- Update or remove memories that turn out to be wrong or outdated",
		"- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.",
	];

	const opener = [
		`You are now acting as the memory extraction subagent. Analyze the most recent ~${options.newMessageCount} messages below and use them to update your persistent memory systems.`,
		"",
		`You MUST only use content from the last ~${options.newMessageCount} messages to update your persistent memories. Do not attempt to investigate or verify that content further — no grepping source files, no reading code to confirm a pattern exists, no git commands.` +
			manifest +
			currentIndexSection,
	].join("\n");

	const outputContract = [
		"## Output format",
		"",
		"Respond with ONLY a JSON object — no prose before or after, no code fences:",
		"",
		'{"files": [{"filename": "topic_name.md", "content": "full memory file content including frontmatter"}], "index_lines": ["- [Title](topic_name.md) — one-line hook"]}',
		"",
		`- \`filename\` must be a bare \`.md\` filename (no directories); it must never be \`${ENTRYPOINT_NAME}\``,
		"- Omit `files` (empty array) when nothing in the messages is worth persisting; same for `index_lines`",
		"- Each `index_lines` entry must point at a file in `files`",
	].join("\n");

	return [
		opener,
		"",
		"If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.",
		"",
		...TYPES_SECTION_INDIVIDUAL,
		...WHAT_NOT_TO_SAVE_SECTION,
		"",
		...howToSave,
		"",
		...outputContract,
	].join("\n");
}

// ============================================================================
// Message serialization
// ============================================================================

/** Extract plain text from a message's string or block-array content. */
function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block !== null && typeof block === "object" && (block as { type?: unknown }).type === "text") {
			const text = (block as { text?: unknown }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.join("\n");
}

/**
 * Serialize the last `maxMessages` user/assistant messages as
 * `role: text` blocks — the extraction model's only view of the conversation.
 */
export function serializeRecentMessages(
	messages: readonly AgentMessage[],
	maxMessages: number = MAX_EXTRACTION_MESSAGES,
): { text: string; count: number } {
	const visible = messages.filter(m => m.role === "user" || m.role === "assistant");
	const recent = visible.slice(-maxMessages);
	const blocks = recent
		.map(m => {
			const text = extractTextContent(m.content).trim();
			if (!text) return null;
			return `${m.role}: ${text}`;
		})
		.filter((b): b is string => b !== null);
	return { text: blocks.join("\n\n"), count: blocks.length };
}

// ============================================================================
// Result parsing + validation
// ============================================================================

export interface ExtractedFile {
	filename: string;
	content: string;
}

export interface ExtractionResult {
	files: ExtractedFile[];
	indexLines: string[];
}

/** True for a bare, safe topic filename: `.md`, not the entrypoint, no path parts. */
export function isValidMemoryFilename(filename: string): boolean {
	if (typeof filename !== "string") return false;
	const trimmed = filename.trim();
	if (!trimmed.toLowerCase().endsWith(".md")) return false;
	if (trimmed === ENTRYPOINT_NAME || trimmed.toLowerCase() === "memory.md") return false;
	if (trimmed.includes("/") || trimmed.includes("\\")) return false;
	if (trimmed.startsWith(".")) return false;
	if (trimmed === "." || trimmed === "..") return false;
	return true;
}

/**
 * Frontmatter-type sanity: if the content carries a frontmatter block with a
 * `type:` field, that field must be one of the four memory types. Content
 * without frontmatter is tolerated (the format is requested, not enforced).
 */
export function hasSaneFrontmatterType(content: string): boolean {
	const lines = content.split("\n");
	if (lines[0]?.trim() !== "---") return true;
	for (let i = 1; i < lines.length && i <= 30; i++) {
		const line = lines[i]!;
		if (line.trim() === "---") return true;
		const match = /^type:\s?(.*)$/.exec(line);
		if (match) return parseMemoryType(match[1]!.trim()) !== undefined;
	}
	return true;
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
 * Parse and validate the extraction model output. Rejected entries (bad
 * filenames, empty content, insane frontmatter types) are dropped silently;
 * the survivors are returned. Returns null for unparseable output.
 */
export function parseExtractionResult(text: string): ExtractionResult | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripCodeFence(text.trim()));
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const record = parsed as Record<string, unknown>;

	const files: ExtractedFile[] = [];
	const rawFiles = Array.isArray(record.files) ? record.files : [];
	for (const raw of rawFiles) {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
		const entry = raw as Record<string, unknown>;
		const filename = entry.filename;
		const content = entry.content;
		if (typeof filename !== "string" || typeof content !== "string") continue;
		if (!isValidMemoryFilename(filename)) continue;
		if (!content.trim()) continue;
		if (!hasSaneFrontmatterType(content)) continue;
		files.push({ filename: filename.trim(), content });
		if (files.length >= MAX_EXTRACTION_FILES) break;
	}

	const indexLines: string[] = [];
	const rawLines = Array.isArray(record.index_lines) ? record.index_lines : [];
	for (const raw of rawLines) {
		if (typeof raw !== "string") continue;
		if (!raw.trim()) continue;
		indexLines.push(raw.trim());
		if (indexLines.length >= MAX_EXTRACTION_INDEX_LINES) break;
	}

	return { files, indexLines };
}

// ============================================================================
// Apply
// ============================================================================

export interface AppliedExtraction {
	written: string[];
	indexAppended: number;
}

/** The topic file linked by a `- [Title](file.md) — hook` index line, if any. */
function indexLineTarget(line: string): string | undefined {
	const match = /\]\(([^)]+)\)/.exec(line);
	const target = match?.[1]?.trim();
	return target !== undefined && target.length > 0 ? target : undefined;
}

/**
 * Apply a validated extraction: write topic files into `memoryDir`, then
 * append the non-duplicate index lines to MEMORY.md (two-step format).
 * Lines already present verbatim are skipped, as are lines whose link target
 * is already indexed — a re-extraction of an existing file with a reworded
 * title/hook must not produce a second pointer to the same topic file.
 */
export async function applyExtraction(memoryDir: string, result: ExtractionResult): Promise<AppliedExtraction> {
	await mkdir(memoryDir, { recursive: true });

	const written: string[] = [];
	for (const file of result.files) {
		const target = path.join(memoryDir, file.filename);
		await writeFile(target, file.content, "utf8");
		written.push(file.filename);
	}

	let indexAppended = 0;
	if (result.indexLines.length > 0) {
		const entrypointPath = claudemdEntrypointPath(memoryDir);
		let existing = "";
		try {
			existing = await readFile(entrypointPath, "utf8");
		} catch {
			// No index yet — start one.
		}
		const existingLines = new Set(existing.split("\n").map(l => l.trim()));
		const indexedTargets = new Set(
			[...existingLines].map(indexLineTarget).filter((target): target is string => target !== undefined),
		);
		const additions: string[] = [];
		for (const line of result.indexLines) {
			const trimmed = line.trim();
			if (existingLines.has(trimmed)) continue;
			const target = indexLineTarget(trimmed);
			if (target !== undefined && indexedTargets.has(target)) continue;
			additions.push(trimmed);
			if (target !== undefined) indexedTargets.add(target);
		}
		if (additions.length > 0) {
			const prefix = existing.length > 0 && !existing.endsWith("\n") ? `${existing}\n` : existing;
			await writeFile(entrypointPath, prefix + additions.join("\n") + "\n", "utf8");
			indexAppended = additions.length;
		}
	}

	return { written, indexAppended };
}

/**
 * The extraction user prompt: instructions + serialized transcript.
 * Kept separate so the call site is a trivial two-argument composition.
 */
export function buildExtractionUserPrompt(prompt: string, transcript: string): string {
	return `${prompt}\n\n---\n\n## Recent messages\n\n${transcript}`;
}
