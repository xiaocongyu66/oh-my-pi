/**
 * Memory-directory scanning primitives — ported from Claude Code's
 * `src/memdir/memoryScan.ts` (see /tmp/cc-port-specs/memory.md §3).
 *
 * Deviations from CC:
 * - `readFileInRange` is replaced by a small head-reader that opens the file,
 *   stats the handle, and reads at most the frontmatter window (one open).
 *   An unterminated frontmatter past the window parses to none (CC's regex
 *   fails the same way on truncated input).
 * - Analytics/telemetry (memoryShapeTelemetry) is stripped.
 */

import { readdir } from "node:fs/promises";
import * as path from "node:path";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { type MemoryType, parseMemoryType } from "./prompts";
import { mergeManifests } from "./index-merge";
import type { MemorySource } from "./paths";

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

export interface ParsedMemoryFrontmatter {
	description: string | null;
	type: MemoryType | undefined;
}

/**
 * CC-parity frontmatter parser for the memory schema: full YAML parse of the
 * leading `---` block (matching CC memoryScan.ts:57 `parseFrontmatter`), so
 * multi-line descriptions, block scalars, and quoted/flow values surface
 * correctly instead of degrading to null. Input is already the ≤
 * FRONTMATTER_MAX_LINES head, so an unterminated block (window cut the closing
 * `---`) yields no description and no type — same as CC's regex missing on
 * truncated input.
 */
export function parseMemoryFrontmatter(content: string): ParsedMemoryFrontmatter {
	if (!content.startsWith("---")) return { description: null, type: undefined };
	const { frontmatter } = parseFrontmatter(content, { level: "off" });
	const rawDescription = frontmatter.description;
	const description = typeof rawDescription === "string" && rawDescription.length > 0 ? rawDescription : null;
	return { description, type: parseMemoryType(frontmatter.type) };
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
 * Scan every active memory source (omp dir plus any Claude directory) and
 * merge the results: basename dedupe with CC-wins, newest-first, global
 * slice cap. Missing directories contribute nothing (scanMemoryFiles → []).
 */
export async function scanMemorySources(
	sources: readonly MemorySource[],
	signal?: AbortSignal,
): Promise<MemoryHeader[]> {
	const parts = await Promise.all(
		sources.map(async source => ({ kind: source.kind, headers: await scanMemoryFiles(source.dir, signal) })),
	);
	return mergeManifests(parts);
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
