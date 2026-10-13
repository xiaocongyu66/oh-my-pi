import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetForTests } from "../../src/web/search/cache";
import { Settings } from "../../src/config/settings";
import { setRagEmbedderForTests, type RagEmbedder } from "../../src/rag/embeddings";
import { WebIndexTool, type WebIndexFetchPage } from "../../src/rag/web-index";
import { WebRecallTool } from "../../src/rag/web-recall";
import { BUILTIN_TOOL_NAMES } from "../../src/tools/builtin-names";
import { BUILTIN_TOOLS, resolveBuiltinToolPlan, type ToolSession } from "../../src/tools";

Bun.env.PI_PYTHON_SKIP_CHECK = "1";

const DOC_URL = "https://example.com/doc";
const DOC_MARKDOWN = `# Quantum tunneling

Quantum tunneling lets particles pass barriers. Quantum effects dominate at nanoscale.

## Section two

This paragraph talks about potatoes, harvesting potatoes in autumn, and potato storage.

## Section three

Ferrofluids climb magnets when the field is strong enough.
`;

let tempDir: string;
let dbPath: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-rag-tools-"));
	dbPath = path.join(tempDir, "web-cache.db");
	process.env.OMP_WEB_CACHE_DB = dbPath;
	resetForTests();
});

afterEach(() => {
	setRagEmbedderForTests(undefined);
	resetForTests();
	if (process.env.OMP_WEB_CACHE_DB === dbPath) delete process.env.OMP_WEB_CACHE_DB;
	fs.rmSync(tempDir, { recursive: true, force: true });
});

/**
 * Deterministic bag-of-words embedder: counts each alphabetic token into a
 * bucket, so an exact-token query scores 1 against chunks containing it and
 * (near) 0 against chunks that do not — enough for stable ordering assertions.
 */
function keywordEmbedder(dim = 8): RagEmbedder {
	return {
		model: "fake-model",
		dim,
		async embed(texts) {
			return texts.map(text => {
				const vector = new Float32Array(dim);
				for (const token of text.toLowerCase().match(/[a-z]+/g) ?? []) {
					let hash = 0;
					for (const ch of token) hash = (hash * 31 + ch.charCodeAt(0)) % dim;
					vector[hash]! += 1;
				}
				return vector;
			});
		},
	};
}

function fakeSession(): ToolSession {
	return {
		cwd: tempDir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

function fakeFetcher(): WebIndexFetchPage {
	return async url => {
		expect(url).toBe(DOC_URL);
		return { content: DOC_MARKDOWN, finalUrl: DOC_URL };
	};
}

describe("web_index", () => {
	it("indexes a fetched page end to end and reports counts", async () => {
		setRagEmbedderForTests(keywordEmbedder());
		const tool = new WebIndexTool(fakeSession(), fakeFetcher());
		const result = await tool.execute("t1", { url: DOC_URL });

		expect(result.isError).toBeUndefined();
		expect(result.content[0]?.type).toBe("text");
		expect(result.content[0]!.text).toContain(`Indexed 3 chunks`);
		expect(result.content[0]!.text).toContain(`from ${DOC_URL}`);
		expect(result.content[0]!.text).toContain(`namespace "web"`);
		expect(result.content[0]!.text).toContain("model fake-model");
		expect(result.details).toMatchObject({
			url: DOC_URL,
			namespace: "web",
			chunks: 3,
			model: "fake-model",
			dim: 8,
		});
		expect(result.details!.chars).toBeGreaterThan(0);
	});

	it("honors namespace and max_chunks", async () => {
		setRagEmbedderForTests(keywordEmbedder());
		const tool = new WebIndexTool(fakeSession(), fakeFetcher());
		const result = await tool.execute("t1", { url: DOC_URL, namespace: "docs", max_chunks: 2 });

		expect(result.details).toMatchObject({ namespace: "docs", chunks: 2 });
	});

	it("degrades honestly when no embedder is available (nothing stored)", async () => {
		setRagEmbedderForTests(null);
		const tool = new WebIndexTool(fakeSession(), fakeFetcher());
		const result = await tool.execute("t1", { url: DOC_URL });

		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("Indexing unavailable");
		expect(result.content[0]!.text).toContain("no embedding backend");
		// Chunking succeeded even though nothing was stored.
		expect(result.details).toMatchObject({ chunks: 3, reason: "no embedder" });
	});

	it("degrades honestly when the web cache DB cannot be opened", async () => {
		setRagEmbedderForTests(keywordEmbedder());
		// Point the env override at a path whose parent is a regular file.
		const blocker = path.join(tempDir, "blocker");
		fs.writeFileSync(blocker, "not a dir");
		const badPath = path.join(blocker, "inner", "web-cache.db");
		process.env.OMP_WEB_CACHE_DB = badPath;
		resetForTests();

		const tool = new WebIndexTool(fakeSession(), fakeFetcher());
		const result = await tool.execute("t1", { url: DOC_URL });

		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("web cache database could not be opened");
		expect(result.details).toMatchObject({ chunks: 3, reason: "web cache db unavailable" });
	});

	it("reports fetch failures as errors", async () => {
		const tool = new WebIndexTool(fakeSession(), async () => {
			throw new Error("boom");
		});
		const result = await tool.execute("t1", { url: DOC_URL });

		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("could not fetch");
		expect(result.content[0]!.text).toContain("boom");
	});
});

describe("web_recall", () => {
	async function seed(): Promise<WebIndexTool> {
		setRagEmbedderForTests(keywordEmbedder());
		const index = new WebIndexTool(fakeSession(), fakeFetcher());
		const result = await index.execute("seed", { url: DOC_URL, namespace: "web" });
		expect(result.isError).toBeUndefined();
		return index;
	}

	it("recalls indexed chunks with the most relevant first", async () => {
		await seed();
		const recall = new WebRecallTool(fakeSession());
		const result = await recall.execute("t1", { query: "potatoes", namespace: "web" });

		expect(result.isError).toBeUndefined();
		expect(result.details!.matches.length).toBeGreaterThan(0);
		expect(result.details!.model).toBe("fake-model");
		const top = result.details!.matches[0]!;
		expect(top.url).toBe(DOC_URL);
		expect(top.chunkIndex).toBe(1); // "Section two" body is the potato chunk.
		expect(top.title).toContain("Section two");
		expect(result.content[0]!.text).toContain(`[1] ## Section two`);
		expect(result.content[0]!.text).toContain(`    ${DOC_URL}`);
		expect(result.content[0]!.text).toMatch(/score \d+\.\d{2}/);
		expect(result.content[0]!.text).toContain("potatoes");

		// The tunneling chunk must not outrank the potato chunk for this query.
		const scores = result.details!.matches.map(match => match.score);
		expect(scores).toEqual([...scores].sort((a, b) => b - a));
	});

	it("isolates namespaces", async () => {
		await seed();
		const recall = new WebRecallTool(fakeSession());
		const other = await recall.execute("t1", { query: "potatoes", namespace: "other" });

		expect(other.isError).toBeUndefined();
		expect(other.details!.matches).toEqual([]);
		expect(other.content[0]!.text).toContain(`No indexed chunks in namespace "other"`);
	});

	it("hints at web_index on an empty store", async () => {
		// Injected embedder keeps the real (slow) local-backend path out of tests.
		setRagEmbedderForTests(keywordEmbedder());
		const recall = new WebRecallTool(fakeSession());
		const result = await recall.execute("t1", { query: "anything", namespace: "fresh" });

		expect(result.isError).toBeUndefined();
		expect(result.details!.matches).toEqual([]);
		expect(result.content[0]!.text).toContain("Index pages first with web_index");
	});

	it("reports unavailability when no embedder is configured", async () => {
		setRagEmbedderForTests(null);
		const recall = new WebRecallTool(fakeSession());
		const result = await recall.execute("t1", { query: "anything" });

		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("Recall unavailable");
		expect(result.details!.matches).toEqual([]);
	});
});

describe("web_index/web_recall wiring", () => {
	it("registers both tools as builtins", () => {
		expect(BUILTIN_TOOL_NAMES).toContain("web_index");
		expect(BUILTIN_TOOL_NAMES).toContain("web_recall");
		expect(typeof BUILTIN_TOOLS.web_index).toBe("function");
		expect(typeof BUILTIN_TOOLS.web_recall).toBe("function");
	});

	it("gates both tools on web_search.enabled and web_search.rag.enabled", async () => {
		const allowed = await resolveBuiltinToolPlan(fakeSession(), ["web_index", "web_recall"]);
		expect(allowed.isAllowed("web_index")).toBe(true);
		expect(allowed.isAllowed("web_recall")).toBe(true);
		expect(allowed.names).toContain("web_index");
		expect(allowed.names).toContain("web_recall");

		const searchOff = await resolveBuiltinToolPlan(
			{ ...fakeSession(), settings: Settings.isolated({ "web_search.enabled": false }) },
			["web_index", "web_recall"],
		);
		expect(searchOff.isAllowed("web_index")).toBe(false);
		expect(searchOff.isAllowed("web_recall")).toBe(false);

		const ragOff = await resolveBuiltinToolPlan(
			{ ...fakeSession(), settings: Settings.isolated({ "web_search.rag.enabled": false }) },
			["web_index", "web_recall"],
		);
		expect(ragOff.isAllowed("web_index")).toBe(false);
		expect(ragOff.isAllowed("web_recall")).toBe(false);
	});

	it("constructs both tools from the BUILTIN_TOOLS factories", async () => {
		const session = fakeSession();
		const index = await BUILTIN_TOOLS.web_index(session);
		const recall = await BUILTIN_TOOLS.web_recall(session);
		expect(index?.name).toBe("web_index");
		expect(recall?.name).toBe("web_recall");
		expect(index?.description.length).toBeGreaterThan(0);
		expect(recall?.description.length).toBeGreaterThan(0);
	});
});
