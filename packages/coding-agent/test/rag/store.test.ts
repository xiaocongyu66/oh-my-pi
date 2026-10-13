import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
	deleteUrl,
	listChunks,
	putQueryVector,
	replaceChunks,
	recentQueryVectors,
	type ReplaceRagChunk,
} from "../../src/rag/store";

function makeDb(): Database {
	return new Database(":memory:");
}

function makeChunk(index: number, embedding: Float32Array, text = `chunk ${index} body`): ReplaceRagChunk {
	return { index, title: `Title ${index}`, text, embedding, model: "test-model", dim: embedding.length };
}

describe("rag store", () => {
	it("round-trips chunks with exact Float32 vectors through the BLOB column", () => {
		const db = makeDb();
		const embedding = new Float32Array([0.25, -1.5, 3.75, 1e-6, -2e-6]);
		const ok = replaceChunks(db, "web", "https://example.com/a", [makeChunk(0, embedding), makeChunk(1, embedding)]);
		expect(ok).toBe(true);

		const rows = listChunks(db, "web");
		expect(rows).toHaveLength(2);
		expect(rows[0]!.url).toBe("https://example.com/a");
		expect(rows[0]!.chunkIndex).toBe(0);
		expect(rows[0]!.title).toBe("Title 0");
		expect(rows[0]!.model).toBe("test-model");
		expect(rows[0]!.dim).toBe(5);
		expect([...rows[0]!.embedding!]).toEqual([...embedding]);
		expect([...rows[1]!.embedding!]).toEqual([...embedding]);
	});

	it("replacing the same URL swaps content instead of duplicating rows", () => {
		const db = makeDb();
		const v1 = new Float32Array([1, 0, 0]);
		const v2 = new Float32Array([0, 1, 0]);
		replaceChunks(db, "web", "https://example.com/a", [makeChunk(0, v1, "old body")]);
		replaceChunks(db, "web", "https://example.com/a", [makeChunk(0, v2, "new body")]);
		const rows = listChunks(db, "web");
		expect(rows).toHaveLength(1);
		expect(rows[0]!.text).toBe("new body");
		expect([...rows[0]!.embedding!]).toEqual([0, 1, 0]);
	});

	it("isolates namespaces from each other", () => {
		const db = makeDb();
		const v = new Float32Array([1, 2, 3]);
		replaceChunks(db, "docs", "https://example.com/a", [makeChunk(0, v)]);
		replaceChunks(db, "web", "https://example.com/b", [makeChunk(0, v)]);
		expect(listChunks(db, "docs").map(r => r.url)).toEqual(["https://example.com/a"]);
		expect(listChunks(db, "web").map(r => r.url)).toEqual(["https://example.com/b"]);
	});

	it("deleteUrl removes only the targeted URL", () => {
		const db = makeDb();
		const v = new Float32Array([1, 2, 3]);
		replaceChunks(db, "web", "https://example.com/a", [makeChunk(0, v)]);
		replaceChunks(db, "web", "https://example.com/b", [makeChunk(0, v)]);
		expect(deleteUrl(db, "web", "https://example.com/a")).toBe(true);
		expect(listChunks(db, "web").map(r => r.url)).toEqual(["https://example.com/b"]);
	});

	it("stores and recalls query vectors newest-first per modality", async () => {
		const db = makeDb();
		const v = new Float32Array([1, 2, 3]);
		putQueryVector(db, "old query", "web", v, "test-model", "key-old");
		await Bun.sleep(5);
		putQueryVector(db, "new query", "web", v, "test-model", "key-new");
		putQueryVector(db, "news query", "news", v, "test-model", "key-news");

		const web = recentQueryVectors(db, "web", 10);
		expect(web.map(r => r.query)).toEqual(["new query", "old query"]);
		expect(web[0]!.cacheKey).toBe("key-new");
		expect([...web[0]!.embedding]).toEqual([...v]);

		expect(recentQueryVectors(db, "news", 10)).toHaveLength(1);
		expect(recentQueryVectors(db, "web", 1)).toHaveLength(1);
		expect(recentQueryVectors(db, "web", 0)).toEqual([]);
	});

	it("degrades to no-op / empty on a closed or broken database instead of throwing", () => {
		const db = makeDb();
		db.close();
		expect(replaceChunks(db, "web", "u", [makeChunk(0, new Float32Array([1]))])).toBe(false);
		expect(listChunks(db, "web")).toEqual([]);
		expect(deleteUrl(db, "web", "u")).toBe(false);
		expect(putQueryVector(db, "q", "web", new Float32Array([1]), "m", "k")).toBe(false);
		expect(recentQueryVectors(db, "web", 5)).toEqual([]);
	});
});
