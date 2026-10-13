import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgWebSearchCommonCrawlIndex } from "@oh-my-pi/pi-coding-agent/web/settings";
import { searchCommonCrawl } from "@oh-my-pi/pi-coding-agent/web/search/providers/commoncrawl";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const sharedAuthStorage = createInMemoryAuthStorage();
const { modelRegistry, model: commonCrawlModel } = (() => {
	const modelRegistry = new ModelRegistry(sharedAuthStorage);
	const model = modelRegistry.find("web", "commoncrawl");
	if (!model) throw new Error("Expected bundled web/commoncrawl model");
	return { modelRegistry, model };
})();

afterAll(() => sharedAuthStorage.close());

function cdxRow(overrides: Partial<Record<string, string>>): Record<string, string> {
	return {
		url: "https://example.com/page",
		timestamp: "20250102030405",
		status: "200",
		mime: "text/html",
		digest: "digest-1",
		filename: "crawl-data/CC-MAIN-2025-08/segments/warc/CC-MAIN-202501.warc.gz",
		offset: "100",
		length: "200",
		...overrides,
	};
}

function makeParams(query: string, fetch: FetchImpl, extra: Record<string, unknown> = {}) {
	return {
		query,
		systemPrompt: "Common Crawl search test prompt",
		authStorage: sharedAuthStorage,
		model: commonCrawlModel,
		modelRegistry,
		fetch,
		...extra,
	};
}

beforeEach(() => {
	resetSettingsForTest();
});

describe("Common Crawl search provider", () => {
	it("queries the CDX index NDJSON endpoint with an over-fetch limit", async () => {
		const urls: string[] = [];
		const fetchMock: FetchImpl = async input => {
			urls.push(String(input));
			return new Response("", { status: 200 });
		};

		await searchCommonCrawl(makeParams("example.com/*", fetchMock, { limit: 10 }));

		expect(urls).toHaveLength(1);
		const url = new URL(urls[0]);
		expect(`${url.protocol}//${url.host}${url.pathname}`).toBe("https://index.commoncrawl.org/CC-MAIN-2025-08-index");
		expect(url.searchParams.get("url")).toBe("example.com/*");
		expect(url.searchParams.get("output")).toBe("json");
		expect(url.searchParams.get("limit")).toBe("40");
	});

	it("parses NDJSON line by line, skipping malformed rows", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(
				[
					JSON.stringify(cdxRow({ url: "https://example.com/a" })),
					"{not json",
					"",
					JSON.stringify(cdxRow({ url: "https://example.com/b", digest: "digest-2" })),
				].join("\n"),
				{ status: 200 },
			);

		const response = await searchCommonCrawl(makeParams("example.com/*", fetchMock));

		expect(response.provider).toBe("commoncrawl");
		expect(response.sources).toHaveLength(2);
		expect(response.sources.map(s => s.url)).toEqual(["https://example.com/a", "https://example.com/b"]);
	});

	it("keeps only HTTP-200 WARC captures with a page-bearing mime", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(
				[
					// Redirect record without a WARC body.
					JSON.stringify(cdxRow({ url: "https://example.com/redirect", status: "301" })),
					// Crawl-diagnostics record: 200 but no warc/ filename.
					JSON.stringify(
						cdxRow({ url: "https://example.com/diag", filename: "crawl-data/CC-MAIN/crawldiagnostics.warc.gz" }),
					),
					// Binary mime is dropped.
					JSON.stringify(cdxRow({ url: "https://example.com/img", mime: "image/png" })),
					// Kept: html, plain text, xml.
					JSON.stringify(cdxRow({ url: "https://example.com/html" })),
					JSON.stringify(cdxRow({ url: "https://example.com/plain", mime: "text/plain" })),
					JSON.stringify(cdxRow({ url: "https://example.com/feed", mime: "application/xml" })),
				].join("\n"),
				{ status: 200 },
			);

		const response = await searchCommonCrawl(makeParams("example.com/*", fetchMock));

		expect(response.sources.map(s => s.url)).toEqual([
			"https://example.com/html",
			"https://example.com/plain",
			"https://example.com/feed",
		]);
		expect(response.sources[0].snippet).toContain("Captured 2025-01-02T03:04:05Z");
		expect(response.sources[0].snippet).toContain("HTTP 200");
	});

	it("takes the index collection from the web_search.commonCrawlIndex setting", async () => {
		const urls: string[] = [];
		const fetchMock: FetchImpl = async input => {
			urls.push(String(input));
			return new Response(JSON.stringify(cdxRow({})), { status: 200 });
		};

		const settings = await Settings.init({ inMemory: true });
		cfgWebSearchCommonCrawlIndex.set(settings, "CC-TEST-INDEX");

		await searchCommonCrawl(makeParams("example.com/*", fetchMock));
		expect(urls[0]).toContain("https://index.commoncrawl.org/CC-TEST-INDEX-index");
		resetSettingsForTest();

		// Without an initialized settings scope the declared default applies.
		await searchCommonCrawl(makeParams("example.com/*", fetchMock));
		expect(urls[1]).toContain("https://index.commoncrawl.org/CC-MAIN-2025-08-index");
	});
});
