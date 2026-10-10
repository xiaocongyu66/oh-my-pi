/**
 * Memory-directory scanning primitives — ported from Claude Code's
 * `src/memdir/memoryScan.ts` (see /tmp/cc-port-specs/memory.md §3).
 *
 * Deviations from CC:
 * - `readFileInRange` is replaced by a small head-reader that opens the file,
 *   stats the handle, and reads at most the frontmatter window (one open).
 * - CC's full-YAML `parseFrontmatter` is replaced by a minimal `key: value`
 *   line parser (the memory schema only needs single-line `description` and
 *   `type` fields). Quoted values are unquoted; anything else degrades to
 *   no description / no type, matching the graceful-degradation contract.
 * - Analytics/telemetry (memoryShapeTelemetry) is stripped.
 */

import { readdir } from "node:fs/promises";
import * as path from "node:path";
import { type MemoryType, parseMemoryType } from "./prompts";

export interface MemoryHeader {
	/** Path RELATIVE to memoryDir. */
	filename: string;
	/** Absolute path. */
	filePath: string;
	mtimeMs: number;
	description: string | null;
	type: MemoryType | undefined;
}

/** Post-sort slice cap on scanned topic files. */
export const MAX_MEMORY_FILES = 200;
/** Frontmatter is parsed from at most this many leading lines. */
export const FRONTMATTER_MAX_LINES = 30;
/** Head-read window for the frontmatter scan (covers 30 generous lines). */
const HEAD_READ_BYTES = 16 * 1024;

/**
 * Read the first `maxLines` lines of a file plus its mtime. Uses a Bun.file
 * slice (at most HEAD_READ_BYTES) — no FileHandle lifecycle to manage.
 * Returns null when the file cannot be read (caller drops the entry).
 */
async function readFileHead(filePath: string, maxLines: number): Promise<{ content: string; mtimeMs: number } | null> {
	try {
		const file = Bun.file(filePath);
		const slice = file.size <= HEAD_READ_BYTES ? file : file.slice(0, HEAD_READ_BYTES);
		const text = await slice.text();
		const lines = text.split("\n");
		if (lines.length > maxLines) lines.length = maxLines;
		return { content: lines.join("\n"), mtimeMs: file.lastModified };
	} catch {
		return null;
	}
}

/** Strip a single level of symmetric quotes from a YAML scalar. */
function unquote(value: string): string {
	if (value.length >= 2) {
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			return value.slice(1, -1);
		}
	}
	return value;
}

export interface ParsedMemoryFrontmatter {
	description: string | null;
	type: MemoryType | undefined;
}

/**
 * Minimal frontmatter parser for the memory schema: a leading `---` block
 * (within the head window) containing single-line `key: value` pairs.
 * No leading `---` (or frontmatter starting after the head window) yields
 * no description and no type — same outcome as CC's regex-based parser
 * failing to match on the truncated head.
 */
export function parseMemoryFrontmatter(content: string): ParsedMemoryFrontmatter {
	const lines = content.split("\n");
	if (lines[0]?.trim() !== "---") return { description: null, type: undefined };
	let description: string | null = null;
	let type: MemoryType | undefined;
	for (let i = 1; i < Math.min(lines.length, FRONTMATTER_MAX_LINES); i++) {
		const line = lines[i]!;
		if (line.trim() === "---") break;
		const match = /^([A-Za-z_-]+):\s?(.*)$/.exec(line);
		if (!match) continue;
		const key = match[1]!;
		const value = unquote(match[2]!.trim());
		if (key === "description") {
			description = value || null;
		} else if (key === "type") {
			type = parseMemoryType(value);
		}
	}
	return { description, type };
}

/**
 * Scan a memory directory for .md files, read their frontmatter, and return
 * a header list sorted newest-first (capped at MAX_MEMORY_FILES). Shared by
 * the recall selector and turn-end extraction (pre-injects the listing so
 * the model doesn't need an `ls` pass). Any error (e.g. dir missing) → [].
 */
export async function scanMemoryFiles(memoryDir: string, signal?: AbortSignal): Promise<MemoryHeader[]> {
	try {
		if (signal?.aborted) return [];
		const entries = await readdir(memoryDir, { recursive: true });
		const mdFiles = entries.filter(f => f.endsWith(".md") && path.basename(f) !== "MEMORY.md");

		const headerResults = await Promise.allSettled(
			mdFiles.map(async (relativePath): Promise<MemoryHeader> => {
				if (signal?.aborted) throw new Error("aborted");
				const filePath = path.join(memoryDir, relativePath);
				const head = await readFileHead(filePath, FRONTMATTER_MAX_LINES);
				if (!head) throw new Error(`unreadable: ${filePath}`);
				const { description, type } = parseMemoryFrontmatter(head.content);
				return {
					filename: relativePath,
					filePath,
					mtimeMs: head.mtimeMs,
					description,
					type,
				};
			}),
		);

		return headerResults
			.filter((r): r is PromiseFulfilledResult<MemoryHeader> => r.status === "fulfilled")
			.map(r => r.value)
			.sort((a, b) => b.mtimeMs - a.mtimeMs)
			.slice(0, MAX_MEMORY_FILES);
	} catch {
		return [];
	}
}

/**
 * Format memory headers as a text manifest: one line per file with
 * `[type] filename (timestamp): description`. Used by both the recall
 * selector prompt and the extraction prompt. Verbatim port.
 */
export function formatMemoryManifest(memories: MemoryHeader[]): string {
	return memories
		.map(m => {
			const tag = m.type ? `[${m.type}] ` : "";
			const ts = new Date(m.mtimeMs).toISOString();
			return m.description ? `- ${tag}${m.filename} (${ts}): ${m.description}` : `- ${tag}${m.filename} (${ts})`;
		})
		.join("\n");
}
