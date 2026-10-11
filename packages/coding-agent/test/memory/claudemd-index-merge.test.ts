import { describe, expect, it } from "bun:test";
import { mergeEntrypoints, mergeManifests } from "../../src/memory/claudemd-backend/index-merge";
import { MAX_ENTRYPOINT_LINES } from "../../src/memory/claudemd-backend/prompts";
import { MAX_MEMORY_FILES, type MemoryHeader } from "../../src/memory/claudemd-backend/scan";

function header(filename: string, mtimeMs: number, description = filename): MemoryHeader {
	return { filename, filePath: `/dir/${filename}`, mtimeMs, description, type: "project" };
}

describe("mergeManifests", () => {
	it("dedupes by basename with CC-project winning", () => {
		const merged = mergeManifests([
			{ kind: "omp", headers: [header("user_role.md", 100, "omp copy")] },
			{ kind: "cc-local", headers: [header("user_role.md", 200, "local copy")] },
			{ kind: "cc-project", headers: [header("user_role.md", 50, "cc copy")] },
		]);
		expect(merged).toHaveLength(1);
		expect(merged[0]!.description).toBe("cc copy");
	});

	it("cc-local wins over omp", () => {
		const merged = mergeManifests([
			{ kind: "omp", headers: [header("a.md", 100, "omp")] },
			{ kind: "cc-local", headers: [header("a.md", 50, "local")] },
		]);
		expect(merged[0]!.description).toBe("local");
	});

	it("keeps unique files from every source, newest-first", () => {
		const merged = mergeManifests([
			{ kind: "omp", headers: [header("omp_only.md", 100)] },
			{ kind: "cc-project", headers: [header("cc_new.md", 300), header("cc_old.md", 1)] },
		]);
		expect(merged.map(h => h.filename)).toEqual(["cc_new.md", "omp_only.md", "cc_old.md"]);
	});

	it("re-applies the global slice cap after merging", () => {
		const many = (kind: string, offset: number, count: number) =>
			Array.from({ length: count }, (_, i) => header(`${kind}${i}.md`, offset + i));
		const merged = mergeManifests([
			{ kind: "omp", headers: many("omp", 0, MAX_MEMORY_FILES) },
			{ kind: "cc-project", headers: many("cc", 1_000_000, MAX_MEMORY_FILES) },
		]);
		expect(merged).toHaveLength(MAX_MEMORY_FILES);
		expect(merged.every(h => h.filename.startsWith("cc"))).toBe(true);
	});
});

describe("mergeEntrypoints", () => {
	it("returns the omp content unchanged when no CC content exists", () => {
		expect(mergeEntrypoints([{ kind: "omp", content: "- [A](a.md) — hook\n" }])).toBe("- [A](a.md) — hook");
	});

	it("returns CC content alone when omp is empty", () => {
		expect(
			mergeEntrypoints([
				{ kind: "cc-project", content: "- [C](c.md) — cc\n" },
				{ kind: "omp", content: "  " },
			]),
		).toBe("- [C](c.md) — cc");
	});

	it("leads with CC sections verbatim and hangs omp entries under a heading", () => {
		const merged = mergeEntrypoints([
			{ kind: "omp", content: "- [O](o.md) — omp hook" },
			{ kind: "cc-project", content: "# Memory Index\n- [C](c.md) — cc hook" },
			{ kind: "cc-local", content: "- [L](l.md) — local hook" },
		]);
		expect(merged).toBe(
			"# Memory Index\n- [C](c.md) — cc hook\n\n- [L](l.md) — local hook\n\n## omp memory\n\n- [O](o.md) — omp hook",
		);
	});

	it("drops the omp section first when the merged index busts the line cap", () => {
		const cc = "# Memory Index\n- [C](c.md) — cc hook";
		const omp = Array.from({ length: MAX_ENTRYPOINT_LINES }, (_, i) => `- [O${i}](o${i}.md) — x`).join("\n");
		const merged = mergeEntrypoints([
			{ kind: "cc-project", content: cc },
			{ kind: "omp", content: omp },
		]);
		expect(merged).toBe(cc);
	});

	it("applies the WARNING truncation to CC-only content when CC itself busts the cap", () => {
		const huge = Array.from({ length: MAX_ENTRYPOINT_LINES + 5 }, (_, i) => `- [C${i}](c${i}.md) — x`).join("\n");
		const merged = mergeEntrypoints([
			{ kind: "cc-project", content: huge },
			{ kind: "omp", content: "- [O](o.md) — small" },
		]);
		expect(merged).toContain("WARNING");
		expect(merged).not.toContain("## omp memory");
		expect(merged.split("\n").length).toBeLessThanOrEqual(MAX_ENTRYPOINT_LINES + 3);
	});
});
