/**
 * Common Crawl Search Provider
 *
 * Free, petabyte-scale open web crawl: queries a Common Crawl CDX index for
 * captured URLs matching a domain/url-prefix (e.g. "example.com/*") and
 * returns archived captures as `archive` results. Ported from hdsearch (MIT)
 * `api/src/providers/search/commoncrawl.ts`.
 *
 * Reference: https://commoncrawl.org/
 */
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { SearchResponse, SearchSource } from "../types";
import { SearchProviderError } from "../../../web/search/types";
import { cfgWebSearchCommonCrawlIndex } from "../../settings";
import { clampNumResults, dateToAgeSeconds } from "../utils";
import { isSettingsInitialized, settings } from "../../../config/settings";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { withHardTimeout } from "./utils";

const DEFAULT_NUM_RESULTS = 10;
/** hdsearch commoncrawl.ts:43 — over-fetch so redirect/diagnostic records can be dropped. */
const MAX_NUM_RESULTS = 200;

/** hdsearch commoncrawl.ts:12-22. */
interface CdxRow {
	url: string;
	timestamp: string;
	status: string;
	mime: string;
	digest: string;
	/** WARC locator — distinguishes real captures from crawl diagnostics. */
	filename: string;
	offset: string;
	length: string;
}

/** Index collection from settings; hdsearch pins CC-MAIN-2025-08 behind an env override. */
function activeIndex(): string {
	try {
		if (isSettingsInitialized()) return cfgWebSearchCommonCrawlIndex.get(settings);
	} catch {
		// Fall through to the declared default.
	}
	return "CC-MAIN-2025-08";
}

/** ISO timestamp from a 14-digit CDX capture timestamp; hdsearch commoncrawl.ts:88-92. */
function cdxDate(ts: string | undefined): string | undefined {
	if (!ts || ts.length < 14) return undefined;
	const y = ts.slice(0, 4);
	const mo = ts.slice(4, 6);
	const d = ts.slice(6, 8);
	const h = ts.slice(8, 10);
	const mi = ts.slice(10, 12);
	const s = ts.slice(12, 14);
	return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
}

/**
 * Prefer real page captures: HTTP 200 with a WARC (not the crawldiagnostics
 * 3xx redirect records, which have no archived body to view) and a
 * text-bearing mime. hdsearch commoncrawl.ts:58-59.
 */
function isPage(row: CdxRow): boolean {
	return row.status === "200" && /warc\//.test(row.filename || "") && /html|text\/plain|xml/.test(row.mime || "");
}

/** Execute a Common Crawl CDX search. */
export async function searchCommonCrawl(params: SearchParams): Promise<SearchResponse> {
	const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const index = activeIndex();
	const url = new URL(`https://index.commoncrawl.org/${index}-index`);
	// CC works on URL patterns; a bare term is treated as a host glob.
	// hdsearch commoncrawl.ts:39.
	const pattern = /[./]/.test(params.query) ? params.query : `${params.query}*`;
	url.searchParams.set("url", pattern);
	url.searchParams.set("output", "json");
	url.searchParams.set("limit", String(Math.min(numResults * 4, MAX_NUM_RESULTS)));

	const fetchImpl = params.fetch ?? fetch;
	const response = await fetchImpl(url, {
		headers: { Accept: "application/json" },
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => "");
		throw new SearchProviderError(
			"commoncrawl",
			`Common Crawl index error (${response.status}): ${errorText.slice(0, 200)}`,
			response.status,
		);
	}

	const body = await response.text();
	// NDJSON: one JSON object per line; bad lines are skipped.
	const parsed: CdxRow[] = [];
	for (const line of body.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			parsed.push(JSON.parse(trimmed) as CdxRow);
		} catch {
			// Skip malformed rows; hdsearch commoncrawl.ts:48-54.
		}
	}

	const pages = parsed.filter(isPage);
	// No 200/HTML captures → settle for any WARC row rather than nothing.
	// hdsearch commoncrawl.ts:61.
	const rows = (pages.length ? pages : parsed.filter(r => /warc\//.test(r.filename || ""))).slice(0, numResults);

	const sources: SearchSource[] = rows.map(row => {
		const publishedDate = cdxDate(row.timestamp);
		return {
			title: row.url,
			url: row.url,
			snippet: `Captured ${cdxDate(row.timestamp) || row.timestamp} · ${row.mime} · HTTP ${row.status}`,
			publishedDate,
			ageSeconds: dateToAgeSeconds(publishedDate),
		};
	});

	return { provider: "commoncrawl", sources };
}

/** Search provider for Common Crawl (no API key required). */
export class CommonCrawlProvider extends SearchProvider {
	readonly id = "commoncrawl";
	readonly label = "Common Crawl";

	isAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	override isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchCommonCrawl(params);
	}
}
