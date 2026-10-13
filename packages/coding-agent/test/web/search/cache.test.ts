/**
 * Contracts for the SQLite web search cache: put/get round-trips, TTL expiry,
 * single-flight collapse, and silent degradation when the DB cannot be opened.
 * `OMP_WEB_CACHE_DB` is pointed at a temp dir per test and restored after.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	getCachedSearch,
	openWebCacheDb,
	putCachedSearch,
	resetForTests,
	singleFlight,
	searchCacheKey,
} from "@oh-my-pi/pi-coding-agent/web/search/cache";

let tempDir: string;
let originalEnv: string | undefined;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "web-cache-"));
	originalEnv = process.env.OMP_WEB_CACHE_DB;
	process.env.OMP_WEB_CACHE_DB = path.join(tempDir, "web-cache.db");
	resetForTests();
});

afterEach(async () => {
	resetForTests();
	if (originalEnv === undefined) {
		delete process.env.OMP_WEB_CACHE_DB;
	} else {
		process.env.OMP_WEB_CACHE_DB = originalEnv;
	}
	await fs.rm(tempDir, { recursive: true, force: true });
});

describe("searchCacheKey", () => {
	it("is deterministic for identical parts and distinct otherwise", () => {
		expect(searchCacheKey(["duckduckgo", "q", 10])).toBe(searchCacheKey(["duckduckgo", "q", 10]));
		expect(searchCacheKey(["duckduckgo", "q", 10])).not.toBe(searchCacheKey(["duckduckgo", "q", 20]));
	});
});

describe("getCachedSearch/putCachedSearch", () => {
	it("round-trips a payload with its fetch timestamp", () => {
		const key = searchCacheKey(["brave", "hello"]);
		const fetchedAt = Date.now();
		putCachedSearch(key, { sources: [1, 2] }, 900, fetchedAt);
		expect(getCachedSearch<{ sources: number[] }>(key, 900)).toEqual({
			payload: { sources: [1, 2] },
			fetchedAt,
		});
	});

	it("returns null for a missing key", () => {
		expect(getCachedSearch("nope", 900)).toBeNull();
	});

	it("serves entries within the TTL and expires entries past it", async () => {
		const key = searchCacheKey(["ddg", "ttl"]);
		const now = Date.now();
		putCachedSearch(key, "fresh", 60_000, now - 5000);
		expect(getCachedSearch(key, 60_000)).toEqual({ payload: "fresh", fetchedAt: now - 5000 });
		expect(getCachedSearch(key, 4000)).toBeNull();
	});

	it("returns null and keeps searching usable when a payload row is corrupt", () => {
		const key = searchCacheKey(["ddg", "corrupt"]);
		putCachedSearch(key, { ok: true }, 900);
		const db = openWebCacheDb();
		expect(db).not.toBeNull();
		db?.query("UPDATE search_cache SET payload = '{not json' WHERE key = ?").run(key);
		expect(getCachedSearch(key, 900)).toBeNull();
	});

	it("reopening against a different DB path after resetForTests does not see old rows", () => {
		const key = searchCacheKey(["ddg", "isolate"]);
		putCachedSearch(key, "old", 900);
		resetForTests();
		process.env.OMP_WEB_CACHE_DB = path.join(tempDir, "other.db");
		resetForTests();
		expect(getCachedSearch(key, 900)).toBeNull();
	});
});

describe("singleFlight", () => {
	it("collapses concurrent identical keys onto one fn invocation", async () => {
		let calls = 0;
		const [a, b] = await Promise.all([
			singleFlight("k1", async () => {
				calls++;
				return "value";
			}),
			singleFlight("k1", async () => {
				calls++;
				return "value";
			}),
		]);
		expect(calls).toBe(1);
		expect(a).toBe("value");
		expect(b).toBe("value");
	});

	it("removes a rejected promise so the next caller retries for real", async () => {
		let calls = 0;
		const first = singleFlight("k2", () => {
			calls++;
			return Promise.reject(new Error("provider down"));
		});
		await expect(first).rejects.toThrow("provider down");
		const second = await singleFlight("k2", () => {
			calls++;
			return Promise.resolve("recovered");
		});
		expect(calls).toBe(2);
		expect(second).toBe("recovered");
	});

	it("does not collapse distinct keys", async () => {
		let calls = 0;
		await Promise.all([
			singleFlight("a", async () => {
				calls++;
				return 1;
			}),
			singleFlight("b", async () => {
				calls++;
				return 2;
			}),
		]);
		expect(calls).toBe(2);
	});
});

describe("degraded DB", () => {
	it("returns null reads and no-op writes instead of throwing when the DB path cannot be created", async () => {
		// A regular file where the parent directory should be: mkdir and SQLite
		// both fail, so openWebCacheDb() must give up gracefully.
		const blocker = path.join(tempDir, "blocker");
		await fs.writeFile(blocker, "not a directory");
		process.env.OMP_WEB_CACHE_DB = path.join(blocker, "inner", "web-cache.db");
		resetForTests();

		expect(openWebCacheDb()).toBeNull();
		expect(getCachedSearch("k", 900)).toBeNull();
		expect(() => putCachedSearch("k", { v: 1 }, 900)).not.toThrow();

		// The in-process single-flight keeps working without any DB.
		let calls = 0;
		const value = await singleFlight("k3", async () => {
			calls++;
			return "ok";
		});
		expect(calls).toBe(1);
		expect(value).toBe("ok");
	});
});
