/**
 * Cross-source merge for the claudemd backend's manifest and MEMORY.md
 * index when Claude directories join the read set.
 *
 * Dedup policy is CC-wins: when the same topic filename exists in both an
 * omp source and a CC source, the CC copy survives — with interop active
 * the CC directory is the copy Claude Code itself reads and writes, and it
 * is also where omp writes, so its index and files stay authoritative.
 */

import * as path from "node:path";
import { MAX_ENTRYPOINT_BYTES, MAX_ENTRYPOINT_LINES, truncateEntrypointContent } from "./prompts";
import { MAX_MEMORY_FILES, type MemoryHeader } from "./scan";
import type { MemorySourceKind } from "./paths";

/** Resolution order for basename collisions: CC project first. */
const KIND_PRIORITY: Record<MemorySourceKind, number> = { "cc-project": 0, "cc-local": 1, omp: 2 };

export interface ManifestPart {
	kind: MemorySourceKind;
	headers: MemoryHeader[];
}

/**
 * Merge per-source header lists: dedupe by basename with CC-wins, re-sort
 * newest-first, and re-apply the global MAX_MEMORY_FILES slice cap.
 */
export function mergeManifests(parts: readonly ManifestPart[]): MemoryHeader[] {
	const ranked = parts
		.flatMap(p => p.headers.map(h => ({ h, rank: KIND_PRIORITY[p.kind] })))
		.sort((a, b) => a.rank - b.rank || b.h.mtimeMs - a.h.mtimeMs);
	const byBasename = new Map<string, MemoryHeader>();
	for (const { h } of ranked) {
		const basename = path.basename(h.filename);
		if (!byBasename.has(basename)) byBasename.set(basename, h);
	}
	return [...byBasename.values()].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_MEMORY_FILES);
}

export interface EntrypointPart {
	kind: MemorySourceKind;
	content: string;
}

function exceedsEntrypointCaps(content: string): boolean {
	return content.split("\n").length > MAX_ENTRYPOINT_LINES || content.length > MAX_ENTRYPOINT_BYTES;
}

function trimmedSection(text: string): string {
	return text.trim();
}

/**
 * Merge per-source MEMORY.md contents. CC sections (project, then local)
 * lead verbatim; omp entries hang under an `## omp memory` heading so the
 * model can tell provenance. When the merged index busts the line/byte caps
 * the omp section is dropped first (CC's own index stays intact), then the
 * existing WARNING truncation applies.
 *
 * Single-source case (no CC content) returns the omp content unchanged —
 * identical to the pre-interop behavior.
 */
export function mergeEntrypoints(parts: readonly EntrypointPart[]): string {
	const sectionFor = (kind: MemorySourceKind) =>
		parts
			.filter(p => p.kind === kind)
			.map(p => trimmedSection(p.content))
			.filter(Boolean)
			.join("\n\n");
	const ccSections = [sectionFor("cc-project"), sectionFor("cc-local")].filter(Boolean).join("\n\n");
	const omp = sectionFor("omp");
	if (!ccSections) return omp;
	if (!omp) return ccSections;

	const merged = `${ccSections}\n\n## omp memory\n\n${omp}`;
	if (!exceedsEntrypointCaps(merged)) return merged;
	return truncateEntrypointContent(ccSections).content;
}
