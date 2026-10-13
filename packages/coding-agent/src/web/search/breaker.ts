/**
 * Circuit breaker for search providers.
 *
 * Ported from hdsearch (MIT) `api/src/provider-breaker.ts`; the Redis
 * state/count keys collapse into one in-process {@link Entry} map, and the
 * per-provider `scope` dimension is dropped (omp keys providers by id alone).
 *
 * WHY: successful results are cacheable, but failures are not — a provider
 * that is out of credits, mis-keyed, or simply slow otherwise gets retried on
 * every request. After two consecutive failures we stop calling the provider
 * for a cooldown and report it as skipped. Cooldown length depends on how
 * fixable the failure looks: an auth/quota problem will not resolve in a
 * minute, a timeout might.
 */

/** hdsearch provider-breaker.ts:16 — one blip shouldn't trip it. */
const FAIL_THRESHOLD = 2;
/** hdsearch provider-breaker.ts:18 — timeouts, 5xx, network: plausibly transient. */
const COOLDOWN_TRANSIENT_MS = 60_000;
/** hdsearch provider-breaker.ts:20 — auth, quota, credits, billing: won't self-fix in a minute. */
const COOLDOWN_PERSISTENT_MS = 300_000;
/** hdsearch provider-breaker.ts:22 — how long the failure counter itself survives, so old blips age out. */
const COUNTER_TTL_MS = 300_000;

/** hdsearch provider-breaker.ts:24-28. */
export interface BreakerState {
	open: boolean;
	reason?: string;
	/** Seconds until the breaker half-opens; absent once the cooldown has elapsed. */
	retryInSec?: number;
}

interface Entry {
	fails: number;
	firstFailAt: number;
	openedAt?: number;
	cooldownMs?: number;
	reason?: string;
}

const entries = new Map<string, Entry>();

/** Does this look like a credential/quota problem rather than a hiccup? hdsearch provider-breaker.ts:38-42. */
export function isPersistentFailure(err: unknown, status?: number): boolean {
	if (status === 401 || status === 402 || status === 403) return true;
	const msg = String((err as Error)?.message || err || "").toLowerCase();
	return /credit|quota|insufficient|billing|payment|unauthorized|forbidden|invalid api key|expired/.test(msg);
}

/**
 * Is the breaker open for this provider? A lapsed cooldown half-opens the
 * breaker (reported as closed) so the provider gets one more chance; the
 * failure counter survives, mirroring the Redis TTLs where the count key
 * outlives a short state key. hdsearch provider-breaker.ts:48-58.
 */
export function breakerState(providerId: string, now: number = Date.now()): BreakerState {
	const entry = entries.get(providerId);
	if (!entry?.openedAt || !entry.cooldownMs) return { open: false };
	const remainingMs = entry.openedAt + entry.cooldownMs - now;
	if (remainingMs <= 0) return { open: false };
	return {
		open: true,
		reason: entry.reason,
		retryInSec: Math.ceil(remainingMs / 1000),
	};
}

/** Record a failure; opens the breaker once the threshold is reached. hdsearch provider-breaker.ts:61-79. */
export function recordFailure(providerId: string, err: unknown, status?: number, now: number = Date.now()): void {
	// Counter aging (hdsearch: the count key's 300s EXPIRE from the first
	// failure): an entry older than COUNTER_TTL_MS starts a fresh count.
	const existing = entries.get(providerId);
	if (existing && now - existing.firstFailAt > COUNTER_TTL_MS) entries.delete(providerId);
	const entry = entries.get(providerId) ?? { fails: 0, firstFailAt: now };
	entry.fails++;
	if (entry.fails < FAIL_THRESHOLD) {
		entries.set(providerId, entry);
		return;
	}
	// hdsearch re-SETs the state key (fresh TTL) on every failure past the
	// threshold; keep openedAt moving so a still-failing provider stays open.
	entry.openedAt = now;
	entry.cooldownMs = isPersistentFailure(err, status) ? COOLDOWN_PERSISTENT_MS : COOLDOWN_TRANSIENT_MS;
	entry.reason = String((err as Error)?.message || err || "request failed").slice(0, 200);
	entries.set(providerId, entry);
}

/** A success clears the failure counter and closes the breaker. hdsearch provider-breaker.ts:82-89. */
export function recordSuccess(providerId: string): void {
	entries.delete(providerId);
}

/** Test helper: forget every provider's breaker state. */
export function resetBreakerForTests(): void {
	entries.clear();
}
