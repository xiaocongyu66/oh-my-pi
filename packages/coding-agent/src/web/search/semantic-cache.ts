/**
 * Query-level semantic cache for the aggregate search pipeline (plan D5).
 *
 * Sits above the per-engine exact cache: when a query misses the exact
 * query-level key, the query is embedded and exact-KNN-matched against the
 * recent query vectors in `search_query_cache` (written by
 * {@link storeSemanticQuery}). A hit replays the *merged aggregate result
 * list* stored under the original query's cache key in `search_cache`,
 * instead of re-running the engine fan-out.
 *
 * Every failure path (no DB rows, no embedder, expired payload, corrupt row,
 * IO error) degrades to a miss: the cache layer must never throw into, or
 * meaningfully stall, the search main path.
 */
import type { Database } from "bun:sqlite";
import { buildExactVectorIndex, searchExactVectorIndex } from "@oh-my-pi/pi-mnemopi/core/vector-index";
import { logger } from "@oh-my-pi/pi-utils";
import { getRagEmbedder } from "../../rag/embeddings";
import { putQueryVector, recentQueryVectors } from "../../rag/store";
import { getCachedSearch } from "./cache";
import type { AggregateResult } from "./normalize";

/**
 * Cosine above which a rewritten query is treated as the same information
 * need. 0.93 keeps paraphrases in and topic drift out: below this, replaying
 * the original result list risks answering the wrong question.
 */
export const SEMANTIC_CACHE_THRESHOLD = 0.93;

/** How many recent query vectors participate in the exact-KNN scan. */
const RECENT_QUERY_WINDOW = 200;

export interface SemanticCacheHit {
	/** The merged aggregate result list stored by the original query. */
	sources: AggregateResult[];
	/** Cosine similarity between the two queries (index scores are cosine). */
	score: number;
	/** The original query text, for provenance notes. */
	originalQuery: string;
}

export interface SemanticLookup {
	/** Query embedding produced this call, reused by the store path to avoid a second embed call. */
	embedding: Float32Array | null;
	/** Model id of the embedder that produced `embedding`. */
	model: string | null;
	/** Semantic hit, when a near-duplicate query with a live payload was found. */
	hit: SemanticCacheHit | null;
}

const NO_LOOKUP: SemanticLookup = { embedding: null, model: null, hit: null };

/**
 * Embed `query` (when any recent vectors exist to match against — otherwise
 * the embedder is never resolved, keeping the cold path embed-free) and return
 * the nearest stored query vector past {@link SEMANTIC_CACHE_THRESHOLD} whose
 * referenced aggregate payload is still inside `ttlMs`. Never throws.
 */
export async function lookupSemanticCache(
	db: Database,
	query: string,
	modality: string,
	ttlMs: number,
): Promise<SemanticLookup> {
	try {
		const rows = recentQueryVectors(db, modality, RECENT_QUERY_WINDOW);
		if (rows.length === 0) return NO_LOOKUP;
		const embedder = await getRagEmbedder();
		if (!embedder) return NO_LOOKUP;
		const [queryEmbedding] = await embedder.embed([query]);
		if (!queryEmbedding || queryEmbedding.length === 0) return NO_LOOKUP;
		// Vectors from a different embedding model live in a different space;
		// their cosine is meaningless, so only same-model rows compete.
		const comparable = rows.filter(row => row.model === embedder.model);
		const index = buildExactVectorIndex(comparable.map(row => ({ id: row, vector: Array.from(row.embedding) })));
		const [top] = searchExactVectorIndex(index, Array.from(queryEmbedding), 1);
		if (!top) return { embedding: queryEmbedding, model: embedder.model, hit: null };
		// buildExactVectorIndex normalizes rows and searchExactVectorIndex
		// normalizes the query, so `score` is already cosine — compare directly.
		if (top.score < SEMANTIC_CACHE_THRESHOLD) {
			return { embedding: queryEmbedding, model: embedder.model, hit: null };
		}
		// The KNN match is only as fresh as its payload: getCachedSearch
		// re-checks fetched_at against the current reader TTL (and drops the
		// row when it expired).
		const payload = getCachedSearch<AggregateResult[]>(top.id.cacheKey, ttlMs);
		if (!payload || !Array.isArray(payload.payload) || payload.payload.length === 0) {
			return { embedding: queryEmbedding, model: embedder.model, hit: null };
		}
		return {
			embedding: queryEmbedding,
			model: embedder.model,
			hit: { sources: payload.payload, score: top.score, originalQuery: top.id.query },
		};
	} catch (err) {
		logger.debug("semantic cache: lookup failed", { err: String(err) });
		return NO_LOOKUP;
	}
}

/**
 * Record one query's embedding so later rewrites can find it via
 * {@link lookupSemanticCache}. Fire-and-forget: failures are logged and
 * swallowed. hdsearch has no counterpart — this is omp's D5 addition.
 */
export function storeSemanticQuery(
	db: Database,
	query: string,
	modality: string,
	embedding: Float32Array,
	model: string,
	cacheKey: string,
): void {
	try {
		putQueryVector(db, query, modality, embedding, model, cacheKey);
	} catch (err) {
		logger.debug("semantic cache: store failed", { err: String(err) });
	}
}
