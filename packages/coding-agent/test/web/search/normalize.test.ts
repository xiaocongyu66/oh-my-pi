/**
 * Contracts for the hdsearch-derived result normalization: URL
 * canonicalization must collapse provider-specific URL noise so identical
 * pages dedup across engines, and aggregation must prefer corroborated /
 * better-ranked results.
 */
import { describe, expect, it } from "bun:test";
import {
	canonicalUrl,
	dedupId,
	dedupe,
	rankAggregate,
	type AggregateResult,
} from "@oh-my-pi/pi-coding-agent/web/search/normalize";

function result(overrides: Partial<AggregateResult> & { source: string; url: string }): AggregateResult {
	return { title: `result from ${overrides.source}`, mergedFrom: [], ...overrides };
}

describe("canonicalUrl", () => {
	it("strips tracking parameters while keeping content parameters", () => {
		expect(
			canonicalUrl(
				"https://example.com/p?utm_source=x&utm_medium=y&fbclid=f&gclid=g&mc_cid=1&mc_eid=2&ref=r&ref_src=s&igshid=i&spm=p&_hsenc=h&_hsmi=m&keep=1",
			),
		).toBe("https://example.com/p?keep=1");
	});

	it("sorts surviving parameters by name so parameter order never splits a dedup id", () => {
		expect(canonicalUrl("https://example.com/p?b=2&a=1&c=3")).toBe("https://example.com/p?a=1&b=2&c=3");
	});

	it("lowercases the host, drops www. and default ports, keeps non-default ports", () => {
		expect(canonicalUrl("http://WWW.Example.com:80/a")).toBe("http://example.com/a");
		expect(canonicalUrl("https://www.Example.com:443/a")).toBe("https://example.com/a");
		expect(canonicalUrl("https://example.com:8443/a")).toBe("https://example.com:8443/a");
	});

	it("drops the hash fragment", () => {
		expect(canonicalUrl("https://example.com/page#section")).toBe("https://example.com/page");
	});

	it("removes trailing slashes except on the bare root path", () => {
		expect(canonicalUrl("https://example.com/dir/")).toBe("https://example.com/dir");
		expect(canonicalUrl("http://example.com/")).toBe("http://example.com/");
	});

	it("returns the trimmed raw string when URL parsing fails", () => {
		expect(canonicalUrl("  not a url  ")).toBe("not a url");
		expect(canonicalUrl("example.com/no-scheme")).toBe("example.com/no-scheme");
	});
});

describe("dedupId", () => {
	it("is stable across URL spellings that canonicalize identically", () => {
		expect(dedupId("https://www.Example.com/a?b=2&a=1")).toBe(dedupId("https://example.com/a?a=1&b=2"));
	});

	it("differs for different pages", () => {
		expect(dedupId("https://example.com/a")).not.toBe(dedupId("https://example.com/b"));
	});

	it("falls back to a lowercased, trimmed title when the URL is empty", () => {
		expect(dedupId("", "  Same Title  ")).toBe(dedupId("", "same title"));
	});
});

describe("dedupe", () => {
	it("collapses URL-equivalent results from multiple providers, keeping the best rank and union provenance", () => {
		const merged = dedupe([
			result({ source: "brave", url: "https://example.com/x", rank: 2 }),
			result({ source: "duckduckgo", url: "https://www.example.com/x/", rank: 1, snippet: "ddg snippet" }),
			result({ source: "tavily", url: "https://example.com/x?utm_source=t", rank: 3 }),
		]);
		expect(merged).toHaveLength(1);
		expect(merged[0].source).toBe("duckduckgo");
		expect(merged[0].rank).toBe(1);
		expect(merged[0].mergedFrom).toEqual(["brave", "duckduckgo", "tavily"]);
	});

	it("keeps the winner's own snippet and backfills from a losing duplicate when the winner has none", () => {
		const merged = dedupe([
			result({ source: "brave", url: "https://example.com/x", rank: 1 }),
			result({ source: "ddg", url: "https://example.com/x", rank: 2, snippet: "loser snippet" }),
		]);
		expect(merged[0].snippet).toBe("loser snippet");
	});

	it("keeps distinct URLs as separate results", () => {
		const merged = dedupe([
			result({ source: "brave", url: "https://example.com/a", rank: 0 }),
			result({ source: "ddg", url: "https://example.com/b", rank: 0 }),
		]);
		expect(merged).toHaveLength(2);
	});
});

describe("rankAggregate", () => {
	it("ranks corroborated results above single-source ones, then by provider rank", () => {
		const ranked = rankAggregate([
			result({ source: "brave", url: "https://a.com", rank: 0, mergedFrom: ["brave"] }),
			result({ source: "ddg", url: "https://b.com", rank: 9, mergedFrom: ["brave", "ddg"] }),
			result({ source: "tavily", url: "https://c.com", rank: 1, mergedFrom: ["tavily"] }),
			result({ source: "kagi", url: "https://d.com", mergedFrom: ["kagi"] }),
		]);
		expect(ranked.map(r => r.url)).toEqual(["https://b.com", "https://a.com", "https://c.com", "https://d.com"]);
	});

	it("treats a missing rank as worst within the same corroboration level", () => {
		const ranked = rankAggregate([
			result({ source: "brave", url: "https://no-rank.com", mergedFrom: ["brave"] }),
			result({ source: "ddg", url: "https://rank-5.com", rank: 5, mergedFrom: ["ddg"] }),
		]);
		expect(ranked.map(r => r.url)).toEqual(["https://rank-5.com", "https://no-rank.com"]);
	});
});
