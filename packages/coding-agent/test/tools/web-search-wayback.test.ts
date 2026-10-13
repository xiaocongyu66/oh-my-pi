import { afterAll, describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { searchWayback } from "@oh-my-pi/pi-coding-agent/web/search/providers/wayback";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const sharedAuthStorage = createInMemoryAuthStorage();
const { modelRegistry, model: waybackModel } = (() => {
	const modelRegistry = new ModelRegistry(sharedAuthStorage);
	const model = modelRegistry.find("web", "wayback");
	if (!model) throw new Error("Expected bundled web/wayback model");
	return { modelRegistry, model };
})();

afterAll(() => sharedAuthStorage.close());

const CDX_HEADER = ["timestamp", "original", "mimetype", "statuscode", "digest"];

function makeParams(query: string, fetch: FetchImpl, extra: Record<string, unknown> = {}) {
	return {
		query,
		systemPrompt: "Wayback search test prompt",
		authStorage: sharedAuthStorage,
		model: waybackModel,
		modelRegistry,
		fetch,
		...extra,
	};
}

describe("Wayback CDX search provider", () => {
	it("queries the CDX index with output=json, statuscode:200, digest collapse and a negative limit", async () => {
		const urls: string[] = [];
		const fetchMock: FetchImpl = async input => {
			urls.push(String(input));
			return new Response(JSON.stringify([CDX_HEADER]), { status: 200 });
		};

		await searchWayback(makeParams("https://example.com/docs", fetchMock, { limit: 7 }));

		expect(urls).toHaveLength(1);
		const url = new URL(urls[0]);
		expect(`${url.protocol}//${url.host}${url.pathname}`).toBe("https://web.archive.org/cdx/search/cdx");
		// A URL-shaped query is passed through untouched.
		expect(url.searchParams.get("url")).toBe("https://example.com/docs");
		expect(url.searchParams.get("output")).toBe("json");
		expect(url.searchParams.get("filter")).toBe("statuscode:200");
		expect(url.searchParams.get("collapse")).toBe("digest");
		expect(url.searchParams.get("fl")).toBe("timestamp,original,mimetype,statuscode,digest");
		expect(url.searchParams.get("limit")).toBe("-7");
	});

	it("treats a bare term as a host glob by appending *", async () => {
		const urls: string[] = [];
		const fetchMock: FetchImpl = async input => {
			urls.push(String(input));
			return new Response(JSON.stringify([CDX_HEADER]), { status: 200 });
		};

		await searchWayback(makeParams("example", fetchMock));

		expect(new URL(urls[0]).searchParams.get("url")).toBe("example*");
	});

	it("parses CDX row arrays into snapshot results", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify([
					CDX_HEADER,
					["20250102030405", "https://example.com/docs/page", "text/html", "200", "digest-a"],
					["20240601000000", "https://example.com/docs/page", "text/plain", "200", "digest-b"],
				]),
				{ status: 200 },
			);

		const response = await searchWayback(makeParams("example.com/docs", fetchMock));

		expect(response.provider).toBe("wayback");
		expect(response.sources).toHaveLength(2);
		// Snapshot URL wraps the original capture; most recent first.
		expect(response.sources[0].url).toBe("https://web.archive.org/web/20250102030405/https://example.com/docs/page");
		expect(response.sources[0].publishedDate).toBe("2025-01-02T03:04:05Z");
		expect(response.sources[0].snippet).toContain("Captured 2025-01-02T03:04:05Z");
		expect(response.sources[0].snippet).toContain("text/html");
		expect(response.sources[1].url).toBe("https://web.archive.org/web/20240601000000/https://example.com/docs/page");
	});

	it("uses the last path segment of the original as the title", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify([
					CDX_HEADER,
					["20250102030405", "https://example.com/deep/path/report.html", "text/html", "200", "d"],
					["20250102030406", "https://example.com/", "text/html", "200", "d"],
				]),
				{ status: 200 },
			);

		const response = await searchWayback(makeParams("example.com", fetchMock));

		expect(response.sources[0].title).toBe("report.html");
		// Host-level capture has no path tail; fall back to the host.
		expect(response.sources[1].title).toBe("example.com");
	});

	it("drops rows without an HTML/text mimetype", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify([
					CDX_HEADER,
					["20250102030405", "https://example.com/img.png", "image/png", "200", "d"],
					["20250102030406", "https://example.com/page", "text/html", "200", "d"],
				]),
				{ status: 200 },
			);

		const response = await searchWayback(makeParams("example.com", fetchMock));

		expect(response.sources).toHaveLength(1);
		expect(response.sources[0].url).toBe("https://web.archive.org/web/20250102030406/https://example.com/page");
	});

	it("yields no sources when the CDX answer is not JSON or has only the header row", async () => {
		const notJson: FetchImpl = async () => new Response("<html>Too Many Requests</html>", { status: 200 });
		expect((await searchWayback(makeParams("example.com", notJson))).sources).toEqual([]);

		const headerOnly: FetchImpl = async () => new Response(JSON.stringify([CDX_HEADER]), { status: 200 });
		expect((await searchWayback(makeParams("example.com", headerOnly))).sources).toEqual([]);
	});
});
