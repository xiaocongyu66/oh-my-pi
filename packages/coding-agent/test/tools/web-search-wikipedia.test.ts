import { afterAll, describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { searchWikipedia } from "@oh-my-pi/pi-coding-agent/web/search/providers/wikipedia";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const sharedAuthStorage = createInMemoryAuthStorage();
const { modelRegistry, model: wikipediaModel } = (() => {
	const modelRegistry = new ModelRegistry(sharedAuthStorage);
	const model = modelRegistry.find("web", "wikipedia");
	if (!model) throw new Error("Expected bundled web/wikipedia model");
	return { modelRegistry, model };
})();

afterAll(() => sharedAuthStorage.close());

function makeParams(query: string, fetch: FetchImpl, extra: Record<string, unknown> = {}) {
	return {
		query,
		systemPrompt: "Wikipedia search test prompt",
		authStorage: sharedAuthStorage,
		model: wikipediaModel,
		modelRegistry,
		fetch,
		...extra,
	};
}

describe("Wikipedia web search provider", () => {
	it("queries the REST search endpoint on the default (en) wiki with a capped limit", async () => {
		const urls: string[] = [];
		const fetchMock: FetchImpl = async input => {
			urls.push(String(input));
			return new Response(
				JSON.stringify({
					pages: [
						{
							key: "Paris",
							title: "Paris",
							excerpt: '<span class="searchmatch">Paris</span> is the capital of France.',
						},
					],
				}),
				{ status: 200 },
			);
		};

		const response = await searchWikipedia(makeParams("paris", fetchMock, { limit: 5 }));

		expect(urls).toHaveLength(1);
		const url = new URL(urls[0]);
		expect(`${url.protocol}//${url.host}${url.pathname}`).toBe("https://en.wikipedia.org/w/rest.php/v1/search/page");
		expect(url.searchParams.get("q")).toBe("paris");
		expect(url.searchParams.get("limit")).toBe("5");
		expect(response.provider).toBe("wikipedia");
		expect(response.sources).toHaveLength(1);
		expect(response.sources[0].url).toBe("https://en.wikipedia.org/wiki/Paris");
		expect(response.sources[0].snippet).toBe("Paris is the capital of France.");
	});

	it("routes a lang: directive to that wiki and strips it from the searched text", async () => {
		const urls: string[] = [];
		const fetchMock: FetchImpl = async input => {
			urls.push(String(input));
			return new Response(JSON.stringify({ pages: [] }), { status: 200 });
		};

		await searchWikipedia(makeParams("lang:de Sonnenystem", fetchMock));

		const url = new URL(urls[0]);
		expect(url.host).toBe("de.wikipedia.org");
		expect(url.searchParams.get("q")).toBe("Sonnenystem");
	});

	it("caps the limit at the REST endpoint maximum of 50", async () => {
		const urls: string[] = [];
		const fetchMock: FetchImpl = async input => {
			urls.push(String(input));
			return new Response(JSON.stringify({ pages: [] }), { status: 200 });
		};

		await searchWikipedia(makeParams("history", fetchMock, { limit: 500 }));

		expect(new URL(urls[0]).searchParams.get("limit")).toBe("50");
	});

	it("strips HTML highlight markup from excerpts and falls back to the description", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					pages: [
						{ key: "A", title: "A", excerpt: 'An <span class="searchmatch">excerpt</span> with tags' },
						{ key: "B", title: "B", description: "Description only, no excerpt" },
					],
				}),
				{ status: 200 },
			);

		const response = await searchWikipedia(makeParams("x", fetchMock));

		expect(response.sources[0].snippet).toBe("An excerpt with tags");
		expect(response.sources[1].snippet).toBe("Description only, no excerpt");
	});

	it("returns no sources for an empty result set", async () => {
		const fetchMock: FetchImpl = async () => new Response(JSON.stringify({ pages: [] }), { status: 200 });

		const response = await searchWikipedia(makeParams("zzz-no-such-article", fetchMock));

		expect(response.provider).toBe("wikipedia");
		expect(response.sources).toEqual([]);
	});
});
