/**
 * SQLite persistence for the web_search RAG pipeline: per-URL chunk rows with
 * their embedding vectors, plus a small cache of recent query vectors.
 *
 * The `Database` handle is injected by the caller (the shared-connection cache
 * layer owns it); this module owns only the DDL and CRUD of its two tables.
 * Every write degrades to a `false` no-op and every read degrades to an empty
 * result on failure: these tables are a cache, and a broken cache must never
 * interrupt the search main path.
 */

import type { Database } from "bun:sqlite";
import { logger } from "@oh-my-pi/pi-utils";

/** Chunk to persist for one URL; `embedding` is `model`'s vector for `text`. */
export interface ReplaceRagChunk {
	index: number;
	title?: string;
	text: string;
	embedding: Float32Array;
	model: string;
	dim: number;
}

export interface RagChunkRow {
	id: number;
	namespace: string;
	url: string;
	chunkIndex: number;
	title: string | null;
	text: string;
	embedding: Float32Array | null;
	model: string | null;
	dim: number | null;
	createdAt: number;
}

export interface QueryVectorRow {
	id: number;
	query: string;
	modality: string;
	embedding: Float32Array;
	model: string;
	cacheKey: string;
	fetchedAt: number;
}

interface RagChunkDbRow {
	id: number;
	namespace: string;
	url: string;
	chunk_index: number;
	title: string | null;
	text: string;
	embedding: Uint8Array | null;
	model: string | null;
	dim: number | null;
	created_at: number;
}

interface QueryVectorDbRow {
	id: number;
	query: string;
	modality: string;
	embedding: Uint8Array;
	model: string;
	cache_key: string;
	fetched_at: number;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS search_query_cache (
	id INTEGER PRIMARY KEY AUTOINCREMENT, query TEXT NOT NULL, modality TEXT NOT NULL,
	embedding BLOB NOT NULL, model TEXT NOT NULL, cache_key TEXT NOT NULL, fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rag_chunks (
	id INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL, url TEXT NOT NULL,
	chunk_index INTEGER NOT NULL, title TEXT, text TEXT NOT NULL,
	embedding BLOB, model TEXT, dim INTEGER, created_at INTEGER NOT NULL,
	UNIQUE(namespace, url, chunk_index)
);
`;

// DDL runs once per handle: re-running it on every call would re-parse the
// schema, and after a mid-session DROP we prefer failing fast (degraded) over
// silently recreating empty tables.
const schemaReady = new WeakSet<Database>();

export function ensureRagSchema(db: Database): boolean {
	if (schemaReady.has(db)) return true;
	try {
		db.exec(SCHEMA_SQL);
		schemaReady.add(db);
		return true;
	} catch (error) {
		logger.debug("rag: schema init failed", { error: describeError(error) });
		return false;
	}
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function float32ToBlob(vector: Float32Array): Uint8Array {
	// Float32Array is 4-byte aligned by construction, so a view over exactly
	// its own bytes is a valid standalone BLOB for the driver.
	return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

function blobToFloat32(blob: Uint8Array): Float32Array {
	// The driver may hand back views at unaligned offsets, which the
	// Float32Array constructor rejects; copy first in that case.
	if (blob.byteOffset % 4 !== 0) {
		return new Float32Array(blob.slice().buffer, 0, Math.floor(blob.byteLength / 4));
	}
	return new Float32Array(blob.buffer, blob.byteOffset, Math.floor(blob.byteLength / 4));
}

export function replaceChunks(
	db: Database,
	namespace: string,
	url: string,
	chunks: readonly ReplaceRagChunk[],
): boolean {
	if (!ensureRagSchema(db)) return false;
	try {
		const now = Date.now();
		const apply = db.transaction((rows: readonly ReplaceRagChunk[]) => {
			db.run("DELETE FROM rag_chunks WHERE namespace = ? AND url = ?", [namespace, url]);
			for (const chunk of rows) {
				db.run(
					`INSERT INTO rag_chunks (namespace, url, chunk_index, title, text, embedding, model, dim, created_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						namespace,
						url,
						chunk.index,
						chunk.title ?? null,
						chunk.text,
						float32ToBlob(chunk.embedding),
						chunk.model,
						chunk.dim,
						now,
					],
				);
			}
		});
		apply(chunks);
		return true;
	} catch (error) {
		logger.debug("rag: replaceChunks failed", { namespace, url, error: describeError(error) });
		return false;
	}
}

export function listChunks(db: Database, namespace: string): RagChunkRow[] {
	if (!ensureRagSchema(db)) return [];
	try {
		const rows = db
			.query<RagChunkDbRow, [string]>(
				"SELECT id, namespace, url, chunk_index, title, text, embedding, model, dim, created_at FROM rag_chunks WHERE namespace = ? ORDER BY url, chunk_index",
			)
			.all(namespace);
		return rows.map(row => ({
			id: row.id,
			namespace: row.namespace,
			url: row.url,
			chunkIndex: row.chunk_index,
			title: row.title,
			text: row.text,
			embedding: row.embedding ? blobToFloat32(row.embedding) : null,
			model: row.model,
			dim: row.dim,
			createdAt: row.created_at,
		}));
	} catch (error) {
		logger.debug("rag: listChunks failed", { namespace, error: describeError(error) });
		return [];
	}
}

export function deleteUrl(db: Database, namespace: string, url: string): boolean {
	if (!ensureRagSchema(db)) return false;
	try {
		db.run("DELETE FROM rag_chunks WHERE namespace = ? AND url = ?", [namespace, url]);
		return true;
	} catch (error) {
		logger.debug("rag: deleteUrl failed", { namespace, url, error: describeError(error) });
		return false;
	}
}

export function putQueryVector(
	db: Database,
	query: string,
	modality: string,
	embedding: Float32Array,
	model: string,
	cacheKey: string,
): boolean {
	if (!ensureRagSchema(db)) return false;
	try {
		db.run(
			"INSERT INTO search_query_cache (query, modality, embedding, model, cache_key, fetched_at) VALUES (?, ?, ?, ?, ?, ?)",
			[query, modality, float32ToBlob(embedding), model, cacheKey, Date.now()],
		);
		return true;
	} catch (error) {
		logger.debug("rag: putQueryVector failed", { modality, error: describeError(error) });
		return false;
	}
}

export function recentQueryVectors(db: Database, modality: string, limit: number): QueryVectorRow[] {
	if (!ensureRagSchema(db)) return [];
	const capped = Math.max(0, Math.trunc(limit));
	if (capped === 0) return [];
	try {
		const rows = db
			.query<QueryVectorDbRow, [string, number]>(
				"SELECT id, query, modality, embedding, model, cache_key, fetched_at FROM search_query_cache WHERE modality = ? ORDER BY fetched_at DESC, id DESC LIMIT ?",
			)
			.all(modality, capped);
		return rows.map(row => ({
			id: row.id,
			query: row.query,
			modality: row.modality,
			embedding: blobToFloat32(row.embedding),
			model: row.model,
			cacheKey: row.cache_key,
			fetchedAt: row.fetched_at,
		}));
	} catch (error) {
		logger.debug("rag: recentQueryVectors failed", { modality, error: describeError(error) });
		return [];
	}
}
