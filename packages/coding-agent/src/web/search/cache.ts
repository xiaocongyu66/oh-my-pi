/**
 * SQLite-backed cache for web search results, shared by the search providers
 * and the future aggregate fan-out.
 *
 * Ported from hdsearch (MIT) `api/src/cache.ts` (`computed`/`singleFlight`);
 * Redis becomes a SQLite table so the cache survives restarts and needs no
 * external service. Connection handling mirrors `tools/github-cache.ts`: one
 * process-wide connection opened lazily on first hit, all IO failures
 * swallowed so a corrupt or unreadable DB degrades to "no cache" and never
 * blocks a search.
 *
 * Only the `search_cache` table lives here; later web modules CREATE IF NOT
 * EXISTS their own tables on this connection.
 *
 * hdsearch gates *what* gets cached at the call site (`shouldCache` — empty
 * result sets are never stored); this layer is a dumb key/value store and
 * trusts callers to follow that rule.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getWebCacheDbPath, logger } from "@oh-my-pi/pi-utils";

interface Row {
	key: string;
	payload: string;
	fetched_at: number;
}

let cachedDb: Database | null = null;
let openAttempted = false;

function ensureParentDir(filePath: string): void {
	try {
		const dir = path.dirname(filePath);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	} catch (err) {
		logger.debug("web cache: failed to create private parent dir", { err: String(err) });
	}
}

function chmodIfExists(filePath: string, mode: number): void {
	try {
		fs.chmodSync(filePath, mode);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			logger.debug("web cache: chmod failed", { err: String(err), path: filePath });
		}
	}
}

function protectDbFiles(dbPath: string): void {
	chmodIfExists(dbPath, 0o600);
	chmodIfExists(`${dbPath}-wal`, 0o600);
	chmodIfExists(`${dbPath}-shm`, 0o600);
}

/**
 * Open (or return) the shared web-cache connection. Returns null whenever the
 * DB cannot be opened — a degraded cache must never stop searches.
 */
export function openWebCacheDb(): Database | null {
	if (cachedDb) return cachedDb;
	if (openAttempted) return null;
	openAttempted = true;
	try {
		const dbPath = getWebCacheDbPath();
		ensureParentDir(dbPath);
		const db = new Database(dbPath);
		// Install the busy handler BEFORE any lock-taking statement. See #2421.
		db.run("PRAGMA busy_timeout = 5000");
		db.run(`
			PRAGMA journal_mode=WAL;
			PRAGMA synchronous=NORMAL;
		`);
		db.run(`
			CREATE TABLE IF NOT EXISTS search_cache (
				key        TEXT    PRIMARY KEY,
				payload    TEXT    NOT NULL,
				fetched_at INTEGER NOT NULL
			)
		`);
		protectDbFiles(dbPath);
		cachedDb = db;
		return db;
	} catch (err) {
		logger.warn("web cache: failed to open DB; cache disabled", { err: String(err) });
		return null;
	}
}

/** hdsearch cache.ts:11 — sha256 hex over the JSON-encoded key parts. */
export function searchCacheKey(parts: readonly unknown[]): string {
	return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/**
 * Read a cached payload if it is younger than `ttlMs`. Expired rows are
 * dropped on read (the cache is regenerable; this bounds on-disk growth
 * without a sweeper). DB unavailable, missing row, and corrupt JSON all
 * return null. hdsearch cache.ts:65-75 (`cacheGet` + per-source TTL).
 */
export function getCachedSearch<T>(key: string, ttlMs: number): { payload: T; fetchedAt: number } | null {
	const db = openWebCacheDb();
	if (!db) return null;
	try {
		const row = db.query("SELECT key, payload, fetched_at FROM search_cache WHERE key = ?").get(key) as
			| Row
			| undefined;
		if (!row) return null;
		const now = Date.now();
		if (now - row.fetched_at > ttlMs) {
			try {
				db.query("DELETE FROM search_cache WHERE key = ?").run(key);
			} catch (err) {
				logger.debug("web cache: expired-row delete failed", { err: String(err) });
			}
			return null;
		}
		let payload: T;
		try {
			payload = JSON.parse(row.payload) as T;
		} catch (err) {
			logger.debug("web cache: corrupt payload row, ignoring", { err: String(err) });
			return null;
		}
		return { payload, fetchedAt: row.fetched_at };
	} catch (err) {
		logger.debug("web cache: read failed", { err: String(err) });
		return null;
	}
}

/**
 * Store a payload under `key`. Fire-and-forget semantics: IO failures are
 * logged and swallowed. Callers own the should-cache policy (never store
 * empty result sets). `ttlMs` is accepted for call-site symmetry with
 * hdsearch's Redis `SET ... EX` but not persisted — expiry is computed at
 * read time from the reader's TTL against `fetched_at`. hdsearch cache.ts:78-85.
 */
export function putCachedSearch<T>(key: string, payload: T, _ttlMs: number, fetchedAt: number = Date.now()): void {
	const db = openWebCacheDb();
	if (!db) return;
	try {
		db.query("INSERT OR REPLACE INTO search_cache (key, payload, fetched_at) VALUES (?, ?, ?)").run(
			key,
			JSON.stringify(payload),
			fetchedAt,
		);
		protectDbFiles(getWebCacheDbPath());
	} catch (err) {
		logger.debug("web cache: write failed", { err: String(err) });
	}
}

/**
 * hdsearch cache.ts:40-48 — collapse concurrent identical calls onto one
 * promise. The loser never executes `fn`; the in-flight promise is removed
 * even on failure so the next caller retries for real.
 */
const inflight = new Map<string, Promise<unknown>>();

export function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const existing = inflight.get(key);
	if (existing) return existing as Promise<T>;
	const p = fn().finally(() => inflight.delete(key));
	inflight.set(key, p);
	return p;
}

/**
 * Test/maintenance helper. Closes and forgets the cached connection so the
 * next access reopens against (possibly) a different DB path.
 */
export function resetForTests(): void {
	if (cachedDb) {
		try {
			cachedDb.close();
		} catch {
			// Closing failures are non-fatal.
		}
	}
	cachedDb = null;
	openAttempted = false;
	inflight.clear();
}
