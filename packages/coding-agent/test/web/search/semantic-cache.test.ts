/**
 * Query-level semantic cache over the aggregate pipeline (plan D5): exact
 * query-level replay, KNN replay of paraphrased queries (0.93 cosine), and
 * the guard rails — modality isolation, no_cache bypass of both layers,
 * expired payload revalidation, and silent degradation without an embedder
 * or without the cache DB. `OMP_WEB_CACHE_DB` points at a temp dir per test
 * and the embedder is injected, so nothing touches the real ~/.omp.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { setRagEmbedderForTests, type RagEmbedder } from "@oh-my-pi/pi-coding-agent/rag/embeddings";
import { recentQueryVectors } from "@oh-my-pi/pi-coding-agent/rag/store";
import { runSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search";
import { resetForTests as resetCacheForTests, openWebCacheDb } from "@oh-my-pi/pi-coding-agent/web/search/cache";
import { SearchProvider } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import * as providerModule from "@oh-my-pi/pi-coding-agent/web/search/provider";
import type { SearchResponse, SearchSource } from "@oh-my-pi/pi-coding-agent/web/search/types";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let tempDir: string;
let originalCacheEnv: string | undefined;

/** Search engine double: returns canned sources and records that it ran. */
class FakeEngine extends SearchProvider {
	readonly searched: string[] = [];

	constructor(
		readonly id: string,
		readonly label: string,
		private readonly sources: SearchSource[],
	) {
		super();
	}

	override isAvailable(): boolean {
		return true;
	}

	override async search(params: SearchParams): Promise<SearchResponse> {
		this.searched.push(params.query);
		return { provider: this.id as SearchResponse["provider"], sources: this.sources };
	}
}

function source(url: string, title?: string): SearchSource {
	return { title: title ?? `result for ${url}`, url };
}

/**
 * Embedder double keyed on exact query text, with a fallback vector for
 * unknown queries. Vectors need not be normalized: the exact index L2
 * normalizes both sides, so scores stay true cosine.
 */
function fakeEmbedder(vectors: Record<string, number[]>, fallback = [0, 0, 1, 0]): RagEmbedder {
	return {
		model: "fake-embedder",
		dim: fallback.length,
		embed: async (texts: readonly string[]) => texts.map(text => Float32Array.from(vectors[text] ?? fallback)),
	};
}

/** 4d test vocabulary: pizza pair is ~0.995 cosine, tokyo/rust are orthogonal. */
const VECTORS: Record<string, number[]> = {
	"best pizza in town": [1, 0, 0, 0],
	"top pizza places nearby": [0.99, 0.1, 0, 0],
	"weather in tokyo": [0, 1, 0, 0],
	"rust async runtime": [0, 0, 1, 0],
};

function mockEngines(engines: FakeEngine[]): void {
	const byId = new Map(engines.map(engine => [engine.id, engine]));
	vi.spyOn(providerModule, "getSearchProvider").mockImplementation(async (id: string) => {
		const engine = byId.get(id);
		if (!engine) throw new Error(`Unexpected provider: ${id}`);
		return engine;
	});
}

beforeEach(async () => {
	resetCacheForTests();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "semantic-cache-"));
	originalCacheEnv = process.env.OMP_WEB_CACHE_DB;
	process.env.OMP_WEB_CACHE_DB = path.join(tempDir, "web-cache.db");
	resetSettingsForTest();
	const settings = await Settings.init({ inMemory: true });
	authStorage = createInMemoryAuthStorage();
	modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
});

afterEach(async () => {
	vi.restoreAllMocks();
	setRagEmbedderForTests(undefined);
	resetSettingsForTest();
	resetCacheForTests();
	authStorage.close();
	if (originalCacheEnv === undefined) delete process.env.OMP_WEB_CACHE_DB;
	else process.env.OMP_WEB_CACHE_DB = originalCacheEnv;
	await fs.rm(tempDir, { recursive: true, force: true });
});

describe("aggregate semantic cache", () => {
	it("runs the engines on first search and stores the query vector", async () => {
		setRagEmbedderForTests(fakeEmbedder(VECTORS));
		const duckduckgo = new FakeEngine("duckduckgo", "DuckDuckGo", [source("https://example.com/pizza")]);
		const wikipedia = new FakeEngine("wikipedia", "Wikipedia", []);
		mockEngines([duckduckgo, wikipedia]);

		const result = await runSearchQuery(
			{ query: "best pizza in town", mode: "aggregate" },
			{ authStorage, modelRegistry },
		);

		expect(duckduckgo.searched).toEqual(["best pizza in town"]);
		expect(result.content[0].text).toContain("https://example.com/pizza");
		expect(result.content[0].text).not.toContain("cached");

		const db = openWebCacheDb();
		expect(db).not.toBeNull();
		const rows = recentQueryVectors(db!, "web", 10);
		expect(rows).toHaveLength(1);
		expect(rows[0].query).toBe("best pizza in town");
		expect(rows[0].model).toBe("fake-embedder");
		expect(rows[0].cacheKey).toHaveLength(64);
	});

	it("serves a second identical search from the query-level cache without calling engines", async () => {
		setRagEmbedderForTests(fakeEmbedder(VECTORS));
		const duckduckgo = new FakeEngine("duckduckgo", "DuckDuckGo", [source("https://example.com/pizza")]);
		const wikipedia = new FakeEngine("wikipedia", "Wikipedia", []);
		mockEngines([duckduckgo, wikipedia]);

		await runSearchQuery({ query: "best pizza in town", mode: "aggregate" }, { authStorage, modelRegistry });
		const second = await runSearchQuery(
			{ query: "best pizza in town", mode: "aggregate" },
			{ authStorage, modelRegistry },
		);

		expect(duckduckgo.searched).toEqual(["best pizza in town"]);
		const text = second.content[0].text;
		expect(text.startsWith("[aggregate: web · cached · 1 results]")).toBe(true);
		expect(text).toContain("cached (exact query match)");
		expect(text).toContain("https://example.com/pizza");
	});

	it("replays a paraphrased query through the semantic hit and cites the original", async () => {
		setRagEmbedderForTests(fakeEmbedder(VECTORS));
		const duckduckgo = new FakeEngine("duckduckgo", "DuckDuckGo", [source("https://example.com/pizza")]);
		const wikipedia = new FakeEngine("wikipedia", "Wikipedia", []);
		mockEngines([duckduckgo, wikipedia]);

		await runSearchQuery({ query: "best pizza in town", mode: "aggregate" }, { authStorage, modelRegistry });
		const paraphrase = await runSearchQuery(
			{ query: "top pizza places nearby", mode: "aggregate" },
			{ authStorage, modelRegistry },
		);

		// The paraphrase never reached the engines and cites where it came from.
		expect(duckduckgo.searched).toEqual(["best pizza in town"]);
		const text = paraphrase.content[0].text;
		expect(text).toContain("cached-semantic (score=");
		expect(text).toContain('from "best pizza in town"');
		expect(text).toContain("https://example.com/pizza");
	});

	it("misses on an unrelated query and runs the engines", async () => {
		setRagEmbedderForTests(fakeEmbedder(VECTORS));
		const duckduckgo = new FakeEngine("duckduckgo", "DuckDuckGo", [source("https://example.com/pizza")]);
		const wikipedia = new FakeEngine("wikipedia", "Wikipedia", []);
		mockEngines([duckduckgo, wikipedia]);

		await runSearchQuery({ query: "best pizza in town", mode: "aggregate" }, { authStorage, modelRegistry });
		const unrelated = await runSearchQuery(
			{ query: "weather in tokyo", mode: "aggregate" },
			{ authStorage, modelRegistry },
		);

		expect(duckduckgo.searched).toEqual(["best pizza in town", "weather in tokyo"]);
		expect(unrelated.content[0].text).not.toContain("cached-semantic");
	});

	it("never replays across modalities", async () => {
		setRagEmbedderForTests(fakeEmbedder(VECTORS));
		const duckduckgo = new FakeEngine("duckduckgo", "DuckDuckGo", [source("https://example.com/pizza")]);
		const wikipedia = new FakeEngine("wikipedia", "Wikipedia", []);
		const searxng = new FakeEngine("searxng", "SearXNG", [source("https://example.com/news")]);
		// Mutable registry: searxng joins only for the news search, so the web
		// seed run cannot fan out to it.
		const byId = new Map([duckduckgo, wikipedia].map(engine => [engine.id, engine]));
		vi.spyOn(providerModule, "getSearchProvider").mockImplementation(async (id: string) => {
			const engine = byId.get(id);
			if (!engine) throw new Error(`Unexpected provider: ${id}`);
			return engine;
		});

		await runSearchQuery({ query: "best pizza in town", mode: "aggregate" }, { authStorage, modelRegistry });
		byId.set("searxng", searxng);
		const news = await runSearchQuery(
			{ query: "top pizza places nearby", mode: "aggregate", modality: "news" },
			{ authStorage, modelRegistry },
		);

		// Web rows are invisible to the news table (and the exact key includes
		// the modality), so searxng really ran.
		expect(duckduckgo.searched).toEqual(["best pizza in town"]);
		expect(searxng.searched).toEqual(["top pizza places nearby"]);
		expect(news.content[0].text).not.toContain("cached-semantic");
	});

	it("no_cache bypasses both cache reads and cache writes", async () => {
		setRagEmbedderForTests(fakeEmbedder(VECTORS));
		const duckduckgo = new FakeEngine("duckduckgo", "DuckDuckGo", [source("https://example.com/rust")]);
		const wikipedia = new FakeEngine("wikipedia", "Wikipedia", []);
		mockEngines([duckduckgo, wikipedia]);

		// Writes: the forced cold run must leave no query vector behind, so the
		// later near-identical paraphrase finds nothing and runs the engines too.
		await runSearchQuery(
			{ query: "best pizza in town", mode: "aggregate", no_cache: true },
			{ authStorage, modelRegistry },
		);
		const paraphrase = await runSearchQuery(
			{ query: "top pizza places nearby", mode: "aggregate" },
			{ authStorage, modelRegistry },
		);
		expect(paraphrase.content[0].text).not.toContain("cached-semantic");

		// Reads: a cached query is re-executed when no_cache is set.
		await runSearchQuery({ query: "weather in tokyo", mode: "aggregate" }, { authStorage, modelRegistry });
		const forced = await runSearchQuery(
			{ query: "weather in tokyo", mode: "aggregate", no_cache: true },
			{ authStorage, modelRegistry },
		);
		expect(forced.content[0].text).not.toContain("cached");

		expect(duckduckgo.searched).toEqual([
			"best pizza in town",
			"top pizza places nearby",
			"weather in tokyo",
			"weather in tokyo",
		]);
	});

	it("skips semantic replay when the referenced payload expired", async () => {
		setRagEmbedderForTests(fakeEmbedder(VECTORS));
		const duckduckgo = new FakeEngine("duckduckgo", "DuckDuckGo", [source("https://example.com/pizza")]);
		const wikipedia = new FakeEngine("wikipedia", "Wikipedia", []);
		mockEngines([duckduckgo, wikipedia]);

		await runSearchQuery({ query: "best pizza in town", mode: "aggregate" }, { authStorage, modelRegistry });
		// Age the stored aggregate payload past the 900s default TTL; the KNN
		// match still fires but its payload must no longer replay.
		const db = openWebCacheDb()!;
		db.run("UPDATE search_cache SET fetched_at = fetched_at - 10000000");

		const paraphrase = await runSearchQuery(
			{ query: "top pizza places nearby", mode: "aggregate" },
			{ authStorage, modelRegistry },
		);
		expect(duckduckgo.searched).toEqual(["best pizza in town", "top pizza places nearby"]);
		expect(paraphrase.content[0].text).not.toContain("cached-semantic");
	});

	it("degrades to plain searches without an embedder", async () => {
		setRagEmbedderForTests(null);
		const duckduckgo = new FakeEngine("duckduckgo", "DuckDuckGo", [source("https://example.com/pizza")]);
		const wikipedia = new FakeEngine("wikipedia", "Wikipedia", []);
		mockEngines([duckduckgo, wikipedia]);

		const result = await runSearchQuery(
			{ query: "best pizza in town", mode: "aggregate" },
			{ authStorage, modelRegistry },
		);

		expect(duckduckgo.searched).toEqual(["best pizza in town"]);
		expect(result.content[0].text).toContain("https://example.com/pizza");
		const db = openWebCacheDb();
		expect(recentQueryVectors(db!, "web", 10)).toHaveLength(0);
	});

	it("degrades to plain searches when the cache DB cannot be opened", async () => {
		setRagEmbedderForTests(fakeEmbedder(VECTORS));
		const duckduckgo = new FakeEngine("duckduckgo", "DuckDuckGo", [source("https://example.com/pizza")]);
		const wikipedia = new FakeEngine("wikipedia", "Wikipedia", []);
		mockEngines([duckduckgo, wikipedia]);

		// A directory is not a SQLite file: the connection must fail closed.
		process.env.OMP_WEB_CACHE_DB = tempDir;
		resetCacheForTests();

		const result = await runSearchQuery(
			{ query: "best pizza in town", mode: "aggregate" },
			{ authStorage, modelRegistry },
		);

		expect(duckduckgo.searched).toEqual(["best pizza in town"]);
		expect(result.content[0].text).toContain("https://example.com/pizza");
		expect(result.content[0].text).not.toContain("cached");
		expect(openWebCacheDb()).toBeNull();
	});
});
