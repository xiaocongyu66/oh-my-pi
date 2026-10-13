/**
 * URL canonicalization + dedup for cross-provider search results.
 *
 * Ported from hdsearch (MIT) `api/src/normalize.ts`; `NormalizedResult` becomes
 * {@link AggregateResult} on top of the omp {@link SearchSource} shape. Two
 * results from different engines pointing at the same page must collapse to
 * one: lowercase host, strip default ports, drop tracking params, trim
 * trailing slash, then hash to a 16-hex dedup id.
 */
import { createHash } from "node:crypto";
import type { SearchSource } from "./types";

/**
 * One search result from a single provider, decorated for aggregation.
 * `rank` is the provider's own ordering (0 = best); `mergedFrom` records which
 * providers contributed a URL-equivalent result.
 */
export interface AggregateResult extends SearchSource {
	/** Provider id that produced this result (e.g. `duckduckgo`, `brave`). */
	source: string;
	/** Position in the provider's own result list; lower is better. */
	rank?: number;
	/** Providers whose result merged into this one, first occurrence first. */
	mergedFrom: string[];
	/** Optional image preview; hdsearch merges it like the snippet. */
	thumbnail?: string;
}

/** hdsearch normalize.ts:7 — same tracking-param table. */
const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$|igshid$|spm$|_hsenc|_hsmi)/i;

/** sha1 hex digest; hdsearch cache.ts:12. (Bun.hash is non-cryptographic and not sha1.) */
function sha1Hex(s: string): string {
	return createHash("sha1").update(s).digest("hex");
}

/**
 * hdsearch normalize.ts:9-31. URL parse failure returns the trimmed input
 * unchanged — a malformed result URL still surfaces, it just never dedups.
 */
export function canonicalUrl(raw: string): string {
	try {
		const u = new URL(raw.trim());
		u.hash = "";
		// WHATWG URL already lowercases protocol and hostname; only www. stripping
		// and default-port removal remain (hdsearch lowercased defensively).
		u.hostname = u.hostname.replace(/^www\./, "");
		if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) {
			u.port = "";
		}
		const keep: Array<[string, string]> = [];
		for (const [key, val] of u.searchParams.entries()) {
			if (!TRACKING_PARAMS.test(key)) keep.push([key, val]);
		}
		keep.sort((a, b) => a[0].localeCompare(b[0]));
		u.search = "";
		for (const [key, val] of keep) u.searchParams.append(key, val);
		let s = u.toString();
		if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
		return s;
	} catch {
		return raw.trim();
	}
}

/** hdsearch normalize.ts:33-36 — stable 16-hex identity; title fallback covers url-less results. */
export function dedupId(url: string, title?: string): string {
	const basis = url ? canonicalUrl(url) : (title || "").toLowerCase().trim();
	return sha1Hex(basis).slice(0, 16);
}

/**
 * Merge duplicate results across providers, keeping the best-ranked instance
 * and recording which providers agreed (a relevance signal for aggregate
 * mode). hdsearch normalize.ts:40-62; omp results carry no upstream `id`, so
 * the dedup id is always recomputed from url/title.
 */
export function dedupe(results: AggregateResult[]): AggregateResult[] {
	const byId = new Map<string, AggregateResult>();
	for (const r of results) {
		const key = dedupId(r.url, r.title);
		const existing = byId.get(key);
		if (!existing) {
			byId.set(key, { ...r, mergedFrom: [r.source] });
			continue;
		}
		// keep the one with the better (lower) rank; merge provenance
		const merged = new Set([...(existing.mergedFrom || []), r.source]);
		const keep = (r.rank ?? Number.MAX_SAFE_INTEGER) < (existing.rank ?? Number.MAX_SAFE_INTEGER) ? r : existing;
		byId.set(key, {
			...keep,
			snippet: keep.snippet || existing.snippet || r.snippet,
			thumbnail: keep.thumbnail || existing.thumbnail || r.thumbnail,
			mergedFrom: [...merged],
		});
	}
	return [...byId.values()];
}

/**
 * Boost results corroborated by multiple engines, then by original rank.
 * hdsearch normalize.ts:65-72 sorts in place; omp returns a copy so callers
 * can keep the provider-interleaved input intact.
 */
export function rankAggregate(results: AggregateResult[]): AggregateResult[] {
	return [...results].sort((a, b) => {
		const ac = a.mergedFrom?.length ?? 1;
		const bc = b.mergedFrom?.length ?? 1;
		if (ac !== bc) return bc - ac;
		return (a.rank ?? 999) - (b.rank ?? 999);
	});
}
