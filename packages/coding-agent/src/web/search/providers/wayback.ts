/**
 * Wayback Machine (Internet Archive) Search Provider
 *
 * Queries the CDX index for captures of a URL/host pattern and returns each
 * capture as an `archive` result linking straight to the rendered snapshot on
 * web.archive.org. Ported from hdsearch (MIT)
 * `api/src/providers/search/wayback.ts` — unlike Common Crawl, snapshots are
 * hosted, browsable pages (no WARC fetch needed) and the CDX endpoint is far
 * more reliably reachable.
 *
 * Reference: https://archive.org/help/wayback_api.php
 */
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { SearchResponse, SearchSource } from "../types";
import { SearchProviderError } from "../../../web/search/types";
import { clampNumResults, dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { withHardTimeout } from "./utils";

const CDX_URL = "https://web.archive.org/cdx/search/cdx";
const DEFAULT_NUM_RESULTS = 10;
/** hdsearch wayback.ts:33 — CDX caps a page at 100 rows. */
const MAX_NUM_RESULTS = 100;
/** hdsearch wayback.ts:35 — the CDX index can take several seconds; give it headroom. */
const WAYBACK_TIMEOUT_MS = 25_000;

/**
 * CDX works on URL patterns; a bare term is treated as a host glob.
 * hdsearch wayback.ts:27.
 */
function cdxPattern(query: string): string {
	return /[./]/.test(query) ? query : `${query}*`;
}

/** ISO timestamp from a 14-digit CDX capture timestamp; hdsearch wayback.ts:75-79. */
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
 * omp surfaces a human title per result; hdsearch used the raw URL. The tail
 * path segment reads better in result lists, falling back to the host and then
 * the raw URL for host-level captures.
 */
function titleForOriginal(original: string): string {
	try {
		const u = new URL(original);
		const tail = u.pathname.split("/").filter(Boolean).pop();
		return tail || u.hostname || original;
	} catch {
		return original;
	}
}

/** Execute a Wayback CDX search. */
export async function searchWayback(params: SearchParams): Promise<SearchResponse> {
	const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const url = new URL(CDX_URL);
	url.searchParams.set("url", cdxPattern(params.query));
	url.searchParams.set("output", "json");
	url.searchParams.set("filter", "statuscode:200");
	// Drop identical re-captures; hdsearch wayback.ts:31.
	url.searchParams.set("collapse", "digest");
	url.searchParams.set("fl", "timestamp,original,mimetype,statuscode,digest");
	// Negative limit → most recent captures first; hdsearch wayback.ts:33.
	url.searchParams.set("limit", String(-numResults));

	const fetchImpl = params.fetch ?? fetch;
	// At least WAYBACK_TIMEOUT_MS even when the dispatcher configured less.
	const response = await fetchImpl(url, {
		headers: { Accept: "application/json" },
		signal: withHardTimeout(params.signal, Math.max(params.timeoutMs ?? 0, WAYBACK_TIMEOUT_MS)),
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => "");
		throw new SearchProviderError(
			"wayback",
			`Wayback CDX error (${response.status}): ${errorText.slice(0, 200)}`,
			response.status,
		);
	}

	const body = await response.text();
	let rows: string[][];
	try {
		rows = JSON.parse(body) as string[][];
	} catch {
		// hdsearch wayback.ts:39-41 — a non-JSON answer (rate-limit page) yields nothing.
		return { provider: "wayback", sources: [] };
	}
	const header = rows?.[0];
	if (!Array.isArray(rows) || rows.length < 2 || !header) return { provider: "wayback", sources: [] };
	const iTs = header.indexOf("timestamp");
	const iUrl = header.indexOf("original");
	const iMime = header.indexOf("mimetype");
	const iStatus = header.indexOf("statuscode");
	if (iTs < 0 || iUrl < 0) return { provider: "wayback", sources: [] };

	const sources: SearchSource[] = [];
	for (const row of rows.slice(1)) {
		const ts = row[iTs];
		const original = row[iUrl];
		if (!ts || !original) continue;
		// hdsearch wayback.ts:52 — keep HTML/text captures only.
		const mime = iMime >= 0 ? row[iMime] : "text/html";
		if (!/html|text/.test(mime || "text/html")) continue;
		const publishedDate = cdxDate(ts);
		sources.push({
			title: titleForOriginal(original),
			// Snapshot locator: the rendered capture, not the live page.
			url: `https://web.archive.org/web/${ts}/${original}`,
			snippet: `Captured ${cdxDate(ts) || ts} · ${mime || "text/html"} · HTTP ${iStatus >= 0 ? row[iStatus] : "200"} · Internet Archive`,
			publishedDate,
			ageSeconds: dateToAgeSeconds(publishedDate),
		});
		if (sources.length >= numResults) break;
	}

	return { provider: "wayback", sources };
}

/** Search provider for the Wayback Machine (no API key required). */
export class WaybackProvider extends SearchProvider {
	readonly id = "wayback";
	readonly label = "Wayback Machine";

	isAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	override isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchWayback(params);
	}
}
