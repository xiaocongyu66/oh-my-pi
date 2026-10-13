import { describe, expect, it } from "bun:test";
import { chunkDocument } from "../../src/rag/chunker";

describe("chunkDocument", () => {
	it("returns no chunks for empty or whitespace-only input", () => {
		expect(chunkDocument("")).toEqual([]);
		expect(chunkDocument("   \n\t\n  ")).toEqual([]);
	});

	it("splits at ATX headings and prefixes the title to every window", () => {
		const chunks = chunkDocument("# Setup\n\nInstall deps first.\n\n# Usage\n\nRun the tool.", {
			maxTokens: 400,
		});
		expect(chunks).toHaveLength(2);
		expect(chunks[0]!.title).toBe("# Setup");
		expect(chunks[0]!.text).toContain("Install deps first.");
		expect(chunks[1]!.title).toBe("# Usage");
		expect(chunks[1]!.text).toContain("Run the tool.");
	});

	it("keeps the deepest of consecutive headings as title and merges shallower ones into the body", () => {
		const chunks = chunkDocument("## Guide\n### Detailed\n\nBody text here.", { maxTokens: 400 });
		expect(chunks).toHaveLength(1);
		expect(chunks[0]!.title).toBe("### Detailed");
		// The shallower heading rides along so its context is not lost.
		expect(chunks[0]!.text).toContain("## Guide");
	});

	it("merges short paragraphs into one window and splits oversized ones on sentences", () => {
		const short = chunkDocument("Para one.\n\nPara two.\n\nPara three.", { maxTokens: 400 });
		expect(short).toHaveLength(1);
		expect(short[0]!.text).toContain("Para one.");
		expect(short[0]!.text).toContain("Para three.");

		const longSentences = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} ends here.`).join(" ");
		const split = chunkDocument(longSentences, { maxTokens: 60, overlapTokens: 0 });
		expect(split.length).toBeGreaterThan(1);
		for (const chunk of split) {
			expect(chunk.text.length).toBeLessThanOrEqual(60 * 4 + 4);
		}
		const rejoined = split.map(c => c.text).join("");
		expect(rejoined.replace(/\s+/g, " ")).toContain("Sentence number 29 ends here.");
	});

	it("never splits a fenced code block, even when it busts the budget", () => {
		const code = ["```js", ...Array.from({ length: 40 }, (_, i) => `console.log(${i});`), "```"].join("\n");
		const chunks = chunkDocument(`# Code\n\nIntro.\n\n${code}\n\nAfter.`, { maxTokens: 50 });
		const codeChunk = chunks.find(c => c.text.includes("console.log(39);"));
		expect(codeChunk).toBeDefined();
		// The whole block landed in exactly one chunk.
		expect(codeChunk!.text).toContain("console.log(0);");
		expect(codeChunk!.text).toContain("console.log(39);");
	});

	it("carries a tail overlap between adjacent windows", () => {
		const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} with some filler content.`).join("\n\n");
		const chunks = chunkDocument(paragraphs, { maxTokens: 40, overlapTokens: 15 });
		expect(chunks.length).toBeGreaterThan(1);
		// The second window starts with material from the end of the first.
		const firstTail = chunks[0]!.text.split("\n\n").at(-1);
		expect(firstTail).toBeDefined();
		expect(chunks[1]!.text).toContain(firstTail!);
	});

	it("assigns sequential indices and preserves every non-whitespace character", () => {
		const doc = "# A\n\nalpha beta.\n\n# B\n\ngamma delta.";
		const chunks = chunkDocument(doc);
		expect(chunks.map(c => c.index)).toEqual(chunks.map((_, i) => i));
		const joined = chunks.map(c => c.text).join(" ");
		for (const word of ["alpha", "beta", "gamma", "delta"]) {
			expect(joined).toContain(word);
		}
	});
});
