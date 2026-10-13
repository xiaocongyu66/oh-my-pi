/**
 * Aggregate (fan-out) search pipeline.
 *
 * Ported from hdsearch (MIT) `api/src/engine.ts` (`runSearchProvider` +
 * the aggregate branch of `runSearch`): query several engines concurrently,
 * soft-deadline each one, merge with cross-engine dedup, and boost results
 * corroborated by multiple engines. The Redis computed-cache collapses into
 * the SQLite web cache ({@link getCachedSearch}) and the Redis breaker into
 * the in-process one ({@link breakerState}).
 */
import type { AuthStorage, Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../../config/model-registry";
import type { SearchEngineId, SearchResponse } from "./types";
import type { SearchModality, SearchParams } from "./providers/base";
import type { SearchProvider } from "./providers/base";
import { breakerState, recordFailure, recordSuccess } from "./breaker";
import { getCachedSearch, putCachedSearch, searchCacheKey } from "./cache";
import { dedupe, rankAggregate, type AggregateResult } from "./normalize";
import { getSearchProvider } from "./provider";

/** hdsearch engine.ts:71-80 — per-engine telemetry for the aggregate response. */
export interface AggregateEngineOutcome {
	engine: string;
	ok: boolean;
	count: number;
	ms: number;
	cached: boolean;
	/** True when the breaker was open and the engine was never called. */
	skipped?: boolean;
	error?: string;
}

/** One engine admitted into the aggregate fan-out. */
export interface AggregateCandidate {
	engine: SearchEngineId;
	provider: SearchProvider;
	model: Model;
}

export interface AggregateResolution {
	usable: AggregateCandidate[];
	skipped: Array<{ engine: string; reason: string }>;
}

/** hdsearch types.ts Modality subset omp supports; archive engines only. */
export const MODALITY_ENGINES: Record<SearchModality, readonly SearchEngineId[]> = {
	web: ["duckduckgo", "wikipedia", "searxng", "brave", "tavily", "exa", "kagi"],
	news: ["searxng", "brave", "tavily", "kagi"],
	images: ["searxng", "brave", "kagi"],
	videos: ["searxng", "brave", "kagi"],
	scholar: ["searxng"],
	code: ["searxng"],
	archive: ["wayback", "commoncrawl"],
};

/** Default merged-result count when the caller did not set `limit`. */
const DEFAULT_AGGREGATE_RESULTS = 10;

/**
 * Resolve the engines eligible for one aggregate search: modality table →
 * catalog model → provider → availability → breaker gate. hdsearch
 * engine.ts:92-105 (breaker) + providers/index.ts resolveSearchCandidates.
 */
export async function resolveAggregateCandidates(
	modality: SearchModality,
	authStorage: AuthStorage,
	modelRegistry: ModelRegistry,
	opts: { noCache?: boolean; disabledEngines?: ReadonlySet<string> },
): Promise<AggregateResolution> {
	const usable: AggregateCandidate[] = [];
	const skipped: Array<{ engine: string; reason: string }> = [];
	for (const engine of MODALITY_ENGINES[modality] ?? MODALITY_ENGINES.web) {
		// `/search` engine management: a user-disabled engine is skipped before any
		// availability work, and surfaces as a skipped outcome like a dead engine.
		if (opts.disabledEngines?.has(engine)) {
			skipped.push({ engine, reason: "disabled by user" });
			continue;
		}
		// hdsearch engine.ts:92-105 — an engine that just failed repeatedly is
		// skipped rather than re-tried; in aggregate mode the request waits for
		// every engine, so a dead one would otherwise add its full timeout.
		const breaker = breakerState(engine);
		if (breaker.open && !opts.noCache) {
			skipped.push({
				engine,
				reason: `skipped after repeated failures (retrying in ${breaker.retryInSec ?? 60}s): ${breaker.reason}`,
			});
			continue;
		}
		const model = modelRegistry.find("web", engine);
		if (!model) {
			skipped.push({ engine, reason: "no web/<id> catalog model" });
			continue;
		}
		let provider: SearchProvider;
		try {
			provider = await getSearchProvider(engine);
		} catch (err) {
			skipped.push({ engine, reason: String((err as Error)?.message || err) });
			continue;
		}
		try {
			if (!(await provider.isAvailable(authStorage, model))) {
				skipped.push({ engine, reason: "unavailable (no credentials/config)" });
				continue;
			}
		} catch (err) {
			skipped.push({ engine, reason: String((err as Error)?.message || err) });
			continue;
		}
		usable.push({ engine, provider, model });
	}
	return { usable, skipped };
}

/**
 * hdsearch engine.ts:160-175 — soft deadline: a straggling engine resolves to
 * `fallback` after `ms` so the response is not held hostage by the slowest
 * engine. First settler wins, the timer is unref'd, and a losing (or failing)
 * promise is silently drained.
 */
export function withSoftDeadline<T>(p: Promise<T>, fallback: T, ms: number): Promise<T> {
	return new Promise(resolve => {
		let done = false;
		const timer = setTimeout(() => {
			if (done) return;
			done = true;
			resolve(fallback);
		}, ms);
		timer.unref?.();
		// The rejection handler keeps a losing failure from surfacing as an
		// unhandled rejection; the deadline fallback still wins.
		void p.then(
			value => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				resolve(value);
			},
			() => {},
		);
	});
}

/**
 * hdsearch engine.ts:81-138 runSearchProvider — run one engine with the cache
 * in front; never throws (failures become outcomes and breaker increments).
 */
async function runAggregateEngine(
	candidate: AggregateCandidate,
	params: Omit<SearchParams, "model">,
	opts: { deadlineMs: number; noCache?: boolean },
): Promise<{ results: AggregateResult[]; outcome: AggregateEngineOutcome }> {
	const t0 = Date.now();
	const { engine, provider, model } = candidate;
	try {
		let response: SearchResponse;
		let cached = false;
		const cacheKey = opts.noCache
			? undefined
			: searchCacheKey([engine, "shared", params.query, params.modality ?? "web", params.limit, params.recency]);
		const hit = cacheKey ? getCachedSearch<SearchResponse>(cacheKey, opts.ttlMs) : null;
		if (hit) {
			response = hit.payload;
			cached = true;
		} else {
			response = await provider.search({ ...params, model });
			// Empty results are often transient (timeout, rate limit) — never cache
			// them. hdsearch engine.ts:108-111 (shouldCache).
			if (cacheKey && response.sources.length > 0) putCachedSearch(cacheKey, response, opts.ttlMs);
		}
		recordSuccess(engine);
		const results = (response.sources ?? []).map((source, rank): AggregateResult => ({
			...source,
			source: engine,
			rank,
			mergedFrom: [engine],
		}));
		return {
			results,
			outcome: { engine, ok: true, count: results.length, ms: Date.now() - t0, cached },
		};
	} catch (err) {
		recordFailure(engine, err, (err as { status?: number }).status);
		return {
			results: [],
			outcome: {
				engine,
				ok: false,
				count: 0,
				ms: Date.now() - t0,
				cached: false,
				error: String((err as Error)?.message || err),
			},
		};
	}
}

/**
 * Fan out to every candidate concurrently (no semaphore — the modality tables
 * top out at 7 engines), soft-deadline each call, merge, dedup, rank, and cap.
 * hdsearch engine.ts:172-195.
 */
export async function runAggregate(
	params: Omit<SearchParams, "model">,
	candidates: readonly AggregateCandidate[],
	opts: { deadlineMs: number; ttlMs: number; noCache?: boolean },
): Promise<{ results: AggregateResult[]; enginesUsed: AggregateEngineOutcome[]; notes: string[] }> {
	const settled = await Promise.all(
		candidates.map(candidate =>
			withSoftDeadline(
				runAggregateEngine(candidate, params, opts),
				{
					results: [] as AggregateResult[],
					outcome: {
						engine: candidate.engine,
						ok: false,
						count: 0,
						ms: opts.deadlineMs,
						cached: false,
						error: "deadline",
					} satisfies AggregateEngineOutcome,
				},
				opts.deadlineMs,
			),
		),
	);

	const enginesUsed: AggregateEngineOutcome[] = [];
	const notes: string[] = [];
	const merged: AggregateResult[] = [];
	for (const entry of settled) {
		// A straggler killed by the soft deadline resolves through the fallback
		// above, bypassing runAggregateEngine's catch — record it here so a
		// chronically slow engine eventually trips the breaker. hdsearch
		// engine.ts:186-193.
		if (entry.outcome.error === "deadline") recordFailure(entry.outcome.engine, new Error("deadline"));
		enginesUsed.push(entry.outcome);
		merged.push(...entry.results);
	}
	for (const outcome of enginesUsed) {
		if (!outcome.ok) notes.push(`${outcome.engine}: ${outcome.error}`);
	}

	const results = rankAggregate(dedupe(merged)).slice(0, params.limit ?? DEFAULT_AGGREGATE_RESULTS);
	return { results, enginesUsed, notes };
}
