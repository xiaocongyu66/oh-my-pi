/**
 * `/search` runtime-state contracts: the symbol-keyed session state round-trips
 * without touching settings or disk; the aggregate engine table honors the
 * user-disabled set; a hosted search model overrides the default role chain
 * exactly like an explicit params.model (but never an explicit per-call one);
 * image-modality results are augmented only when multimodal parsing is on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as ai from "@oh-my-pi/pi-ai";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search";
import { resolveAggregateCandidates } from "@oh-my-pi/pi-coding-agent/web/search/aggregate";
import { SearchProvider } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import * as providerModule from "@oh-my-pi/pi-coding-agent/web/search/provider";
import * as visionDescribe from "@oh-my-pi/pi-coding-agent/web/search/vision-describe";
import {
	ensureWebSearchSessionState,
	getWebSearchSessionState,
	setWebSearchSessionState,
	describeWebSearchSessionState,
} from "@oh-my-pi/pi-coding-agent/web/search/session-state";
import {
	augmentSourcesWithImageDescriptions,
	createImageDescriber,
	extractImageDescription,
	isImageLikeUrl,
} from "@oh-my-pi/pi-coding-agent/web/search/vision-describe";
import type { SearchParams, SearchResponse } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { resetForTests as resetCacheForTests } from "@oh-my-pi/pi-coding-agent/web/search/cache";
import { setRagEmbedderForTests } from "@oh-my-pi/pi-coding-agent/rag/embeddings";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let tempDir: string;
let originalCacheEnv: string | undefined;

beforeEach(async () => {
	resetSettingsForTest();
	const settings = await Settings.init({ inMemory: true });
	authStorage = createInMemoryAuthStorage();
	modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
	// Aggregate searches read and write the shared web cache (and consult the
	// RAG embedder); isolate the DB to a temp file and force the embedder
	// unavailable so nothing touches the real ~/.omp.
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-state-"));
	originalCacheEnv = process.env.OMP_WEB_CACHE_DB;
	process.env.OMP_WEB_CACHE_DB = path.join(tempDir, "web-cache.db");
	setRagEmbedderForTests(null);
	resetCacheForTests();
});

afterEach(async () => {
	vi.restoreAllMocks();
	setRagEmbedderForTests(undefined);
	resetCacheForTests();
	if (originalCacheEnv === undefined) delete process.env.OMP_WEB_CACHE_DB;
	else process.env.OMP_WEB_CACHE_DB = originalCacheEnv;
	await fs.rm(tempDir, { recursive: true, force: true });
	resetSettingsForTest();
	authStorage.close();
});

function fakeSession(): AgentSession {
	return { sessionId: "test-session" } as unknown as AgentSession;
}

describe("web search session state", () => {
	it("round-trips through the symbol-keyed slot and dies with the session object", () => {
		const session = fakeSession();
		expect(getWebSearchSessionState(session)).toBeUndefined();

		const state = ensureWebSearchSessionState(session);
		expect(state.disabledEngines).toBeInstanceOf(Set);
		expect(getWebSearchSessionState(session)).toBe(state);

		state.searchModel = "gemini/gemini-2.5-pro";
		state.disabledEngines.add("brave");
		expect(getWebSearchSessionState(session)?.searchModel).toBe("gemini/gemini-2.5-pro");
		expect(getWebSearchSessionState(session)?.disabledEngines.has("brave")).toBe(true);

		// A second session object never sees the first session's state.
		expect(getWebSearchSessionState(fakeSession())).toBeUndefined();
	});

	it("replace and clear via setWebSearchSessionState return the previous state", () => {
		const session = fakeSession();
		const first = ensureWebSearchSessionState(session);
		first.searchModel = "web/duckduckgo";

		const replacement = { disabledEngines: new Set(["kagi"]) };
		expect(setWebSearchSessionState(session, replacement)).toBe(first);
		expect(getWebSearchSessionState(session)).toBe(replacement);
		expect(setWebSearchSessionState(session, undefined)).toBe(replacement);
		expect(getWebSearchSessionState(session)).toBeUndefined();
	});

	it("summarizes the current toggles for status output", () => {
		expect(describeWebSearchSessionState(undefined)).toContain("off");
		const state = ensureWebSearchSessionState(fakeSession());
		state.searchModel = "web/kagi";
		state.disabledEngines.add("brave");
		state.disabledEngines.add("tavily");
		const summary = describeWebSearchSessionState(state);
		expect(summary).toContain("Search model: web/kagi");
		expect(summary).toContain("brave, tavily");
	});
});

describe("aggregate disabled engines", () => {
	it("keeps user-disabled engines out of the fan-out and reports them as skipped", async () => {
		const enabled = await resolveAggregateCandidates("archive", authStorage, modelRegistry, {});
		expect(enabled.usable.map(candidate => candidate.engine).sort()).toEqual(["commoncrawl", "wayback"]);

		const disabled = await resolveAggregateCandidates("archive", authStorage, modelRegistry, {
			disabledEngines: new Set(["wayback"]),
		});
		expect(disabled.usable.map(candidate => candidate.engine)).toEqual(["commoncrawl"]);
		expect(disabled.skipped).toEqual([{ engine: "wayback", reason: "disabled by user" }]);
	});
});

/** Search engine double: records selectors that reached search(). */
class RecordingEngine extends SearchProvider {
	readonly searched: string[] = [];

	constructor(
		readonly id: string,
		private readonly response: Partial<SearchResponse> = {},
	) {
		super();
	}

	override isAvailable(): boolean {
		return true;
	}

	override async search(params: SearchParams): Promise<SearchResponse> {
		this.searched.push(`${params.model.provider}/${params.model.id}`);
		return { provider: "duckduckgo", sources: [{ title: "hit", url: "https://example.com/page" }], ...this.response };
	}
}

function mockEngines(engines: RecordingEngine[]): void {
	const byId = new Map(engines.map(engine => [engine.id, engine]));
	vi.spyOn(providerModule, "getSearchProvider").mockImplementation(async (id: string) => {
		const engine = byId.get(id);
		if (!engine) throw new Error(`Unexpected provider: ${id}`);
		return engine;
	});
}

describe("hosted search model override", () => {
	it("routes default web_search calls to the /search-hosted model instead of the role chain", async () => {
		const duckduckgo = new RecordingEngine("duckduckgo");
		mockEngines([duckduckgo]);

		const result = await runSearchQuery(
			{ query: "hello" },
			{
				authStorage,
				modelRegistry,
				sessionSearchState: { searchModel: "web/duckduckgo", disabledEngines: new Set() },
			},
		);

		// The hosted pick ran explicitly; the default chain's first engine (web/parallel) never did.
		expect(duckduckgo.searched).toEqual(["web/duckduckgo"]);
		expect(result.content[0].text).toContain("https://example.com/page");
	});

	it("an explicit params.model wins over the session's hosted model", async () => {
		const duckduckgo = new RecordingEngine("duckduckgo");
		const wikipedia = new RecordingEngine("wikipedia");
		mockEngines([duckduckgo, wikipedia]);

		await runSearchQuery(
			{ query: "hello", model: "web/wikipedia" },
			{
				authStorage,
				modelRegistry,
				sessionSearchState: { searchModel: "web/duckduckgo", disabledEngines: new Set() },
			},
		);

		expect(duckduckgo.searched).toEqual([]);
		expect(wikipedia.searched).toEqual(["web/wikipedia"]);
	});

	it("aggregate mode keeps using the engine table with the disabled set applied", async () => {
		const wayback = new RecordingEngine("wayback");
		mockEngines([wayback]);

		await runSearchQuery(
			{ query: "hello", mode: "aggregate", modality: "archive" },
			{
				authStorage,
				modelRegistry,
				sessionSearchState: { disabledEngines: new Set(["commoncrawl"]) },
			},
		);

		expect(wayback.searched).toEqual(["web/wayback"]);
	});
});

describe("multimodal image parsing gate", () => {
	it("augments image-modality sources only when the session enabled a vision model", async () => {
		const augment = vi
			.spyOn(visionDescribe, "augmentSourcesWithImageDescriptions")
			.mockImplementation(async sources => sources.map(source => ({ ...source, snippet: "[image: mock desc]" })));
		const duckduckgo = new RecordingEngine("duckduckgo");
		mockEngines([duckduckgo]);

		const enabled = await runSearchQuery(
			{ query: "sunset", modality: "images", model: "web/duckduckgo" },
			{
				authStorage,
				modelRegistry,
				sessionSearchState: { multimodalModel: "anthropic/claude-sonnet-4-5", disabledEngines: new Set() },
			},
		);
		expect(augment).toHaveBeenCalledTimes(1);
		expect(enabled.content[0].text).toContain("[image: mock desc]");

		await runSearchQuery(
			{ query: "sunset", modality: "images", model: "web/duckduckgo" },
			{ authStorage, modelRegistry },
		);
		expect(augment).toHaveBeenCalledTimes(1);
	});

	it("leaves web-modality responses untouched even when a vision model is configured", async () => {
		const augment = vi
			.spyOn(visionDescribe, "augmentSourcesWithImageDescriptions")
			.mockImplementation(async sources => sources.map(source => ({ ...source, snippet: "[image: mock desc]" })));
		const duckduckgo = new RecordingEngine("duckduckgo");
		mockEngines([duckduckgo]);

		const result = await runSearchQuery(
			{ query: "sunset", model: "web/duckduckgo" },
			{
				authStorage,
				modelRegistry,
				sessionSearchState: { multimodalModel: "anthropic/claude-sonnet-4-5", disabledEngines: new Set() },
			},
		);
		expect(augment).not.toHaveBeenCalled();
		expect(result.content[0].text).not.toContain("[image:");
	});
});

describe("vision-describe", () => {
	it("detects image-like URLs by extension", () => {
		expect(isImageLikeUrl("https://example.com/pic.PNG")).toBe(true);
		expect(isImageLikeUrl("https://example.com/a/b.jpg?size=large")).toBe(true);
		expect(isImageLikeUrl("https://example.com/page")).toBe(false);
		expect(isImageLikeUrl("https://example.com/photo.png/embed")).toBe(false);
	});

	it("extracts the first non-empty line and caps its length", () => {
		expect(extractImageDescription("\n  A red square on white.  \nsecond line")).toBe("A red square on white.");
		expect(extractImageDescription(undefined)).toBeUndefined();
		const long = extractImageDescription("x".repeat(500));
		expect(long?.length).toBe(240);
	});

	it("appends image descriptions to image-like sources only", async () => {
		const sources = [
			{ title: "pic", url: "https://example.com/a.png", snippet: "original" },
			{ title: "page", url: "https://example.com/page" },
		];
		const seen: string[] = [];
		const result = await augmentSourcesWithImageDescriptions(sources, async url => {
			seen.push(url);
			return "a small test image";
		});

		expect(seen).toEqual(["https://example.com/a.png"]);
		expect(result[0].snippet).toBe("original [image: a small test image]");
		expect(result[1].snippet).toBeUndefined();
	});

	it("fails soft: a rejecting describer and a missing api key both leave sources untouched", async () => {
		const sources = [{ title: "pic", url: "https://example.com/a.png" }];
		const rejecting = await augmentSourcesWithImageDescriptions(sources, async () => {
			throw new Error("boom");
		});
		expect(rejecting).toEqual(sources);

		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled claude-sonnet-4-5 model");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple");
		const describer = createImageDescriber({ model, apiKey: undefined });
		await expect(describer("https://example.com/a.png")).resolves.toBeUndefined();
		expect(completeSimpleMock).not.toHaveBeenCalled();
	});

	it("describes an image through the vision model and returns its one-line reply", async () => {
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled claude-sonnet-4-5 model");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "A red square." }],
		} as never);
		const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const fetchImpl = (async () =>
			new Response(pngBytes, { status: 200, headers: { "content-type": "image/png" } })) as typeof fetch;

		const describer = createImageDescriber({ model, apiKey: "test-key", fetch: fetchImpl });
		await expect(describer("https://example.com/a.png")).resolves.toBe("A red square.");

		const context = completeSimpleMock.mock.calls[0]?.[1];
		if (!context) throw new Error("Expected completeSimple to be called with a context");
		const userContent = context.messages[0];
		if (!userContent) throw new Error("Expected a user message");
		expect(Array.isArray(userContent.content)).toBe(true);
		const imageBlock = (userContent.content as Array<{ type: string; data?: string; mimeType?: string }>).find(
			block => block.type === "image",
		);
		expect(imageBlock?.mimeType).toBe("image/png");
		expect(imageBlock?.data).toBe(Buffer.from(pngBytes).toString("base64"));
	});
});
