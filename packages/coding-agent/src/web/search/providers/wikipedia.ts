/**
 * Wikipedia REST Search Provider
 *
 * Free, key-less full-text search over Wikipedia via the MediaWiki REST API
 * (`GET /w/rest.php/v1/search/page`). Authoritative reference hits; good for
 * grounding and entity lookups. Ported from hdsearch (MIT)
 * `api/src/providers/search/wikipedia.ts`.
 *
 * Reference: https://www.mediawiki.org/wiki/API:REST_API
 */
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { SearchResponse, SearchSource } from "../types";
import { SearchProviderError } from "../../../web/search/types";
import { formatQuery, parseSearchQuery } from "../query";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { withHardTimeout } from "./utils";

const DEFAULT_NUM_RESULTS = 10;
/** hdsearch wikipedia.ts:31 — the REST endpoint rejects limit > 50. */
const MAX_NUM_RESULTS = 50;

/** hdsearch wikipedia.ts:8-14. */
interface WikiPage {
	key: string;
	title: string;
	description?: string;
	excerpt?: string;
}

interface WikiSearchResponse {
	pages?: WikiPage[];
}

/**
 * Strip the `<span class="searchmatch">` highlight markup the REST excerpts
 * wrap query terms in; hdsearch wikipedia.ts:37.
 */
function stripHtmlTags(value: string): string {
	return value.replace(/<[^>]+>/g, "").trim();
}

/** Execute a Wikipedia REST search. */
export async function searchWikipedia(params: SearchParams): Promise<SearchResponse> {
	const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	// hdsearch wikipedia.ts:28 — a `lang:` directive picks the wiki, first two
	// letters only; everything else defaults to English.
	const lang = (parsed.lang || "en").slice(0, 2);
	// The REST endpoint is a plain text index; rebuild directive-free terms so
	// `lang:` (already consumed above) and friends are not searched verbatim.
	const query = parsed.hasDirectives ? formatQuery(parsed, {}) : params.query;
	const url = new URL(`https://${lang}.wikipedia.org/w/rest.php/v1/search/page`);
	url.searchParams.set("q", query);
	url.searchParams.set("limit", String(numResults));

	const fetchImpl = params.fetch ?? fetch;
	const response = await fetchImpl(url, {
		headers: { Accept: "application/json" },
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => "");
		throw new SearchProviderError(
			"wikipedia",
			`Wikipedia API error (${response.status}): ${errorText.slice(0, 200)}`,
			response.status,
		);
	}

	const data = (await response.json()) as WikiSearchResponse;
	const sources: SearchSource[] = [];
	for (const page of data.pages ?? []) {
		if (!page.key) continue;
		sources.push({
			title: page.title || page.key,
			// hdsearch wikipedia.ts:36 — keys are wiki page slugs, safe to encode.
			url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.key)}`,
			// Excerpt carries HTML highlight tags; fall back to the short description.
			snippet: stripHtmlTags(page.excerpt || page.description || "") || undefined,
		});
	}

	return { provider: "wikipedia", sources: sources.slice(0, numResults) };
}

/** Search provider for Wikipedia (no API key required). */
export class WikipediaProvider extends SearchProvider {
	readonly id = "wikipedia";
	readonly label = "Wikipedia";

	isAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	override isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchWikipedia(params);
	}
}
