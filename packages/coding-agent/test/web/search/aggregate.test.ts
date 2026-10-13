/**
 * Contracts for the hdsearch-derived aggregate fan-out: soft deadlines must
 * never let one straggler hold the response, the modality engine table stays
 * well-formed, and runAggregate merges/dedups/ranks across engines. The
 * executeSearch early branch routes mode=aggregate around the role chain.
 * `OMP_WEB_CACHE_DB` is pointed at a temp dir per test so nothing touches the
 * real ~/.omp cache.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { setRagEmbedderForTests } from "@oh-my-pi/pi-coding-agent/rag/embeddings";
import { runSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search";
import {
	MODALITY_ENGINES,
	resolveAggregateCandidates,
	runAggregate,
	withSoftDeadline,
	type AggregateCandidate,
} from "@oh-my-pi/pi-coding-agent/web/search/aggregate";
import { recordFailure, resetBreakerForTests } from "@oh-my-pi/pi-coding-agent/web/search/breaker";
import { resetForTests as resetCacheForTests } from "@oh-my-pi/pi-coding-agent/web/search/cache";
import { SearchProvider } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import type { SearchProviderId } from "@oh-my-pi/pi-tui/tools/web-search-types";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import * as providerModule from "@oh-my-pi/pi-coding-agent/web/search/provider";
import {
	SEARCH_PROVIDER_LABELS,
	type SearchResponse,
	type SearchSource,
} from "@oh-my-pi/pi-coding-agent/web/search/types";
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
	override readonly id: SearchProviderId;
	override readonly label: string;
	readonly searched: string[] = [];

	constructor(
		id: string,
		label: string,
		private readonly sources: SearchSource[],
		private readonly available = true,
	) {
		super();
		this.id = id as SearchProviderId;
		this.label = label;
	}

	override isAvailable(): boolean {
		return this.available;
	}

	override async search(params: SearchParams): Promise<SearchResponse> {
		this.searched.push(params.query);
		return { provider: this.id as SearchResponse["provider"], sources: this.sources };
	}
}

function source(url: string, title?: string): SearchSource {
	return { title: title ?? `result for ${url}`, url };
}

function candidate(engine: FakeEngine, modelId?: string): AggregateCandidate {
	const model = modelRegistry.find("web", modelId ?? engine.id);
	if (!model) throw new Error(`Missing catalog model web/${engine.id}`);
	return { engine: engine.id as AggregateCandidate["engine"], provider: engine, model };
}

function aggregateParams(overrides: Record<string, unknown> = {}) {
	return {
		query: "shared query",
		systemPrompt: "aggregate test prompt",
		authStorage,
		modelRegistry,
		limit: 5,
		...overrides,
	};
}

beforeEach(async () => {
	resetBreakerForTests();
	resetCacheForTests();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aggregate-cache-"));
	originalCacheEnv = process.env.OMP_WEB_CACHE_DB;
	process.env.OMP_WEB_CACHE_DB = path.join(tempDir, "web-cache.db");
	// The query-level cache consults the RAG embedder on the store path; force
	// it unavailable so these tests never bootstrap the mnemopi subprocess.
	setRagEmbedderForTests(null);
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
	resetBreakerForTests();
	authStorage.close();
	if (originalCacheEnv === undefined) delete process.env.OMP_WEB_CACHE_DB;
	else process.env.OMP_WEB_CACHE_DB = originalCacheEnv;
	await fs.rm(tempDir, { recursive: true, force: true });
});

describe("withSoftDeadline", () => {
	it("resolves the promise value when it settles before the deadline", async () => {
		const winner = new Promise<string>(resolve => setTimeout(() => resolve("winner"), 5));
		await expect(withSoftDeadline(winner, "fallback", 1_000)).resolves.toBe("winner");
	});

	it("resolves the fallback when the deadline elapses first", async () => {
		const straggler = new Promise<string>(resolve => setTimeout(() => resolve("too late"), 50));
		await expect(withSoftDeadline(straggler, "fallback", 5)).resolves.toBe("fallback");
		// Drain the straggler so its late settlement does not outlive the test.
		await straggler;
	});

	it("drains a losing rejection without surfacing it", async () => {
		const lateFailure = new Promise<string>((_, reject) => setTimeout(() => reject(new Error("late boom")), 20));
		await expect(withSoftDeadline(lateFailure, "fallback", 5)).resolves.toBe("fallback");
		await new Promise(resolve => setTimeout(resolve, 40));
	});
});

describe("MODALITY_ENGINES", () => {
	it("covers exactly the seven supported modalities with registered engines", () => {
		expect(Object.keys(MODALITY_ENGINES).sort()).toEqual(
			["archive", "code", "images", "news", "scholar", "videos", "web"].sort(),
		);
		for (const engines of Object.values(MODALITY_ENGINES)) {
			for (const engine of engines) {
				expect(SEARCH_PROVIDER_LABELS).toHaveProperty(engine);
			}
		}
	});

	it("matches the planned per-modality tables", () => {
		expect(MODALITY_ENGINES.web).toEqual(["duckduckgo", "wikipedia", "searxng", "brave", "tavily", "exa", "kagi"]);
		expect(MODALITY_ENGINES.news).toEqual(["searxng", "brave", "tavily", "kagi"]);
		expect(MODALITY_ENGINES.images).toEqual(["searxng", "brave", "kagi"]);
		expect(MODALITY_ENGINES.videos).toEqual(["searxng", "brave", "kagi"]);
		expect(MODALITY_ENGINES.scholar).toEqual(["searxng"]);
		expect(MODALITY_ENGINES.code).toEqual(["searxng"]);
		expect(MODALITY_ENGINES.archive).toEqual(["wayback", "commoncrawl"]);
	});
});

describe("resolveAggregateCandidates", () => {
	it("admits the free archive engines without any credentials", async () => {
		const resolution = await resolveAggregateCandidates("archive", authStorage, modelRegistry, {});
		expect(resolution.usable.map(candidate => candidate.engine).sort()).toEqual(["commoncrawl", "wayback"]);
	});

	it("skips credential-gated engines and reports why", async () => {
		const resolution = await resolveAggregateCandidates("web", authStorage, modelRegistry, {});
		const engines = resolution.usable.map(candidate => candidate.engine).sort();
		// duckduckgo/wikipedia need no key; exa defers its key to search time;
		// searxng has no endpoint; brave/tavily/kagi have no credentials.
		expect(engines).toEqual(["duckduckgo", "exa", "wikipedia"]);
		const skippedEngines = resolution.skipped.map(skip => skip.engine).sort();
		expect(skippedEngines).toEqual(["brave", "kagi", "searxng", "tavily"]);
		for (const skip of resolution.skipped) {
			expect(skip.reason.length).toBeGreaterThan(0);
		}
	});

	it("skips an engine whose breaker is open unless noCache forces it", async () => {
		recordFailure("wayback", new Error("boom"));
		recordFailure("wayback", new Error("boom"));

		const gated = await resolveAggregateCandidates("archive", authStorage, modelRegistry, {});
		expect(gated.usable.map(candidate => candidate.engine)).toEqual(["commoncrawl"]);
		expect(gated.skipped).toEqual([
			{ engine: "wayback", reason: expect.stringContaining("skipped after repeated failures") },
		]);

		const forced = await resolveAggregateCandidates("archive", authStorage, modelRegistry, { noCache: true });
		expect(forced.usable.map(candidate => candidate.engine).sort()).toEqual(["commoncrawl", "wayback"]);
	});
});

describe("runAggregate", () => {
	it("merges URL-equivalent results across engines and ranks corroborated results first", async () => {
		const duckduckgo = new FakeEngine("duckduckgo", "DuckDuckGo", [
			source("https://example.com/y", "Y from ddg"),
			source("https://example.com/x", "X from ddg"),
		]);
		const wikipedia = new FakeEngine("wikipedia", "Wikipedia", [
			source("https://www.example.com/x/", "X from wikipedia"),
			source("https://example.com/z", "Z from wikipedia"),
		]);

		const { results, enginesUsed } = await runAggregate(
			aggregateParams(),
			[candidate(duckduckgo), candidate(wikipedia)],
			{ deadlineMs: 1_000, ttlMs: 60_000 },
		);

		expect(enginesUsed).toHaveLength(2);
		expect(enginesUsed.every(outcome => outcome.ok)).toBe(true);
		// example.com/x appears in both engines (canonicalized across www./trailing slash):
		// corroborated results lead, keeping the better-ranked instance's own URL
		// spelling (wikipedia's, rank 0 vs duckduckgo's rank 1) and merged provenance.
		expect(results[0].url).toBe("https://www.example.com/x/");
		expect(results[0].mergedFrom).toEqual(["duckduckgo", "wikipedia"]);
		expect(results[0].rank).toBe(0);
		// Single-engine results follow in engine-rank order, deduped to the limit.
		expect(results.map(result => result.url)).toEqual([
			"https://www.example.com/x/",
			"https://example.com/y",
			"https://example.com/z",
		]);
	});

	it("caps merged results at the requested limit", async () => {
		const duckduckgo = new FakeEngine("duckduckgo", "DuckDuckGo", [
			source("https://example.com/1"),
			source("https://example.com/2"),
			source("https://example.com/3"),
		]);
		const wikipedia = new FakeEngine("wikipedia", "Wikipedia", [source("https://example.com/4")]);

		const { results } = await runAggregate(
			aggregateParams({ limit: 3 }),
			[candidate(duckduckgo), candidate(wikipedia)],
			{
				deadlineMs: 1_000,
				ttlMs: 60_000,
			},
		);

		expect(results).toHaveLength(3);
	});

	it("serves a second identical run from the cache and skips empty result sets", async () => {
		const duckduckgo = new FakeEngine("duckduckgo", "DuckDuckGo", [source("https://example.com/cached")]);
		const empty = new FakeEngine("wikipedia", "Wikipedia", []);

		const first = await runAggregate(aggregateParams(), [candidate(duckduckgo), candidate(empty)], {
			deadlineMs: 1_000,
			ttlMs: 60_000,
		});
		expect(first.enginesUsed.map(outcome => outcome.cached)).toEqual([false, false]);

		const second = await runAggregate(aggregateParams(), [candidate(duckduckgo), candidate(empty)], {
			deadlineMs: 1_000,
			ttlMs: 60_000,
		});
		// The non-empty engine's response came from cache; the empty one was never stored.
		expect(second.enginesUsed.map(outcome => outcome.cached)).toEqual([true, false]);
		expect(second.results.map(result => result.url)).toEqual(["https://example.com/cached"]);
		expect(duckduckgo.searched).toHaveLength(1);
	});

	it("reports engine failures and notes them instead of throwing", async () => {
		const failing = new FakeEngine("duckduckgo", "DuckDuckGo", []);
		vi.spyOn(failing, "search").mockRejectedValue(new Error("engine exploded"));
		const healthy = new FakeEngine("wikipedia", "Wikipedia", [source("https://example.com/ok")]);

		const { results, enginesUsed, notes } = await runAggregate(
			aggregateParams(),
			[candidate(failing), candidate(healthy)],
			{
				deadlineMs: 1_000,
				ttlMs: 60_000,
			},
		);

		expect(results.map(result => result.url)).toEqual(["https://example.com/ok"]);
		expect(enginesUsed.find(outcome => outcome.engine === "duckduckgo")?.error).toContain("engine exploded");
		expect(notes.some(note => note.includes("duckduckgo: engine exploded"))).toBe(true);
	});

	it("resolves a straggler through the deadline fallback and records the failure", async () => {
		const straggler = new FakeEngine("duckduckgo", "DuckDuckGo", [source("https://example.com/slow")]);
		vi.spyOn(straggler, "search").mockImplementation(
			() =>
				new Promise<SearchResponse>(resolve =>
					setTimeout(() => resolve({ provider: "duckduckgo", sources: [] }), 200),
				),
		);
		const fast = new FakeEngine("wikipedia", "Wikipedia", [source("https://example.com/fast")]);

		const { results, enginesUsed } = await runAggregate(aggregateParams(), [candidate(straggler), candidate(fast)], {
			deadlineMs: 20,
			ttlMs: 60_000,
		});

		expect(results.map(result => result.url)).toEqual(["https://example.com/fast"]);
		const outcome = enginesUsed.find(entry => entry.engine === "duckduckgo");
		expect(outcome?.error).toBe("deadline");
		expect(outcome?.ms).toBe(20);
		// Draining so the late settlement does not outlive the test.
		await new Promise(resolve => setTimeout(resolve, 200));
	});
});

describe("executeSearch aggregate early branch", () => {
	function mockEngines(engines: FakeEngine[]): void {
		const byId = new Map<string, FakeEngine>(engines.map(engine => [engine.id, engine]));
		vi.spyOn(providerModule, "getSearchProvider").mockImplementation(async (id: string) => {
			const engine = byId.get(id);
			if (!engine) throw new Error(`Unexpected provider: ${id}`);
			return engine;
		});
	}

	it("fans out over the modality table and never walks the role chain", async () => {
		const wayback = new FakeEngine("wayback", "Wayback Machine", [
			source("https://web.archive.org/web/1/https://example.com"),
		]);
		const commoncrawl = new FakeEngine("commoncrawl", "Common Crawl", []);
		mockEngines([wayback, commoncrawl]);

		const result = await runSearchQuery(
			{ query: "example.com", mode: "aggregate", modality: "archive" },
			{ authStorage, modelRegistry },
		);

		// Only archive-table engines ran; web/parallel and friends never got touched.
		expect(wayback.searched).toEqual(["example.com"]);
		expect(commoncrawl.searched).toEqual(["example.com"]);
		const text = result.content[0].text;
		expect(text.startsWith("[aggregate: archive · 2 engines · 1 results]")).toBe(true);
		expect(text).toContain("https://web.archive.org/web/1/https://example.com");
	});

	it("defaults to the web modality and degrades with a note when the vertical is empty", async () => {
		const duckduckgo = new FakeEngine("duckduckgo", "DuckDuckGo", [source("https://example.com/ddg")]);
		const wikipedia = new FakeEngine("wikipedia", "Wikipedia", [source("https://en.wikipedia.org/wiki/X")]);
		mockEngines([duckduckgo, wikipedia]);

		// `scholar` maps to searxng only, which has no endpoint configured → degrade to web.
		const result = await runSearchQuery(
			{ query: "cold fusion", mode: "aggregate", modality: "scholar" },
			{
				authStorage,
				modelRegistry,
			},
		);

		const text = result.content[0].text;
		expect(text).toContain('no engines available for modality "scholar"; fell back to web');
		expect(text.startsWith("[aggregate: web · 2 engines · 2 results]")).toBe(true);
		expect(duckduckgo.searched).toEqual(["cold fusion"]);
	});

	it("reports a no-engine aggregate as an error", async () => {
		mockEngines([]);
		// archive engines are always available unless the breaker gates them; force
		// emptiness by opening both breakers.
		recordFailure("wayback", new Error("down"));
		recordFailure("wayback", new Error("down"));
		recordFailure("commoncrawl", new Error("down"));
		recordFailure("commoncrawl", new Error("down"));

		const result = await runSearchQuery(
			{ query: "example.com", mode: "aggregate", modality: "archive" },
			{ authStorage, modelRegistry },
		);

		expect(result.details.error).toContain("No web search engines available");
	});
});
