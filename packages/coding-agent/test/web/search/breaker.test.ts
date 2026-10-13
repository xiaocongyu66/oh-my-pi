/**
 * Contracts for the provider circuit breaker (hdsearch port): one failure is
 * tolerated, two consecutive failures open a cooldown whose length depends on
 * the failure class, success closes it, and stale counters age out. Clock is
 * injected via the trailing `now` parameters — no global timer mutation.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	breakerState,
	isPersistentFailure,
	recordFailure,
	recordSuccess,
	resetBreakerForTests,
} from "@oh-my-pi/pi-coding-agent/web/search/breaker";

const T0 = 1_700_000_000_000;

afterEach(() => {
	resetBreakerForTests();
});

describe("isPersistentFailure", () => {
	it("classifies auth/billing statuses and credential-flavored messages as persistent", () => {
		expect(isPersistentFailure(new Error("boom"), 401)).toBe(true);
		expect(isPersistentFailure(new Error("boom"), 402)).toBe(true);
		expect(isPersistentFailure(new Error("boom"), 403)).toBe(true);
		expect(isPersistentFailure(new Error("Invalid API Key supplied"))).toBe(true);
		expect(isPersistentFailure(new Error("insufficient credit, please top up"))).toBe(true);
		expect(isPersistentFailure(new Error("Quota exceeded for this month"))).toBe(true);
		expect(isPersistentFailure(new Error("UNAUTHORIZED"))).toBe(true);
		expect(isPersistentFailure(new Error("token has expired"))).toBe(true);
	});

	it("classifies timeouts, 5xx, and network errors as transient", () => {
		expect(isPersistentFailure(new Error("request timed out"), 500)).toBe(false);
		expect(isPersistentFailure(new Error("fetch failed"))).toBe(false);
		expect(isPersistentFailure(new Error("boom"), 429)).toBe(false);
	});
});

describe("breaker lifecycle", () => {
	it("does not open after a single failure", () => {
		recordFailure("prov", new Error("timeout"), undefined, T0);
		expect(breakerState("prov", T0)).toEqual({ open: false });
	});

	it("opens after two consecutive failures with a 60s transient cooldown", () => {
		recordFailure("prov", new Error("timeout"), undefined, T0);
		recordFailure("prov", new Error("timeout"), undefined, T0);
		const state = breakerState("prov", T0);
		expect(state.open).toBe(true);
		expect(state.reason).toBe("timeout");
		expect(state.retryInSec).toBe(60);
	});

	it("uses a 300s cooldown for persistent failures", () => {
		recordFailure("prov", new Error("Invalid API Key"), 401, T0);
		recordFailure("prov", new Error("Invalid API Key"), 401, T0);
		expect(breakerState("prov", T0).retryInSec).toBe(300);
	});

	it("reports retryInSec counting down and half-opens once the cooldown elapses", () => {
		recordFailure("prov", new Error("timeout"), undefined, T0);
		recordFailure("prov", new Error("timeout"), undefined, T0);
		expect(breakerState("prov", T0 + 59_999).open).toBe(true);
		expect(breakerState("prov", T0 + 60_000)).toEqual({ open: false });
	});

	it("re-opens from a single post-cooldown failure because the counter outlives a short cooldown", () => {
		recordFailure("prov", new Error("timeout"), undefined, T0);
		recordFailure("prov", new Error("timeout"), undefined, T0);
		expect(breakerState("prov", T0 + 60_000).open).toBe(false);
		recordFailure("prov", new Error("timeout"), undefined, T0 + 61_000);
		expect(breakerState("prov", T0 + 61_000).open).toBe(true);
	});

	it("closes the breaker and clears the count on success", () => {
		recordFailure("prov", new Error("timeout"), undefined, T0);
		recordFailure("prov", new Error("timeout"), undefined, T0);
		recordSuccess("prov");
		expect(breakerState("prov", T0)).toEqual({ open: false });
		// A single fresh failure after success must not trip the breaker again.
		recordFailure("prov", new Error("timeout"), undefined, T0 + 1000);
		expect(breakerState("prov", T0 + 1000)).toEqual({ open: false });
	});

	it("forgets the failure count once it ages past 300s from the first failure", () => {
		recordFailure("prov", new Error("timeout"), undefined, T0);
		// Within the aging window the two blips accumulate and open the breaker…
		recordFailure("prov", new Error("timeout"), undefined, T0 + 299_999);
		expect(breakerState("prov", T0 + 299_999).open).toBe(true);
		resetBreakerForTests();

		// …but a second blip past the aging window starts a fresh count.
		recordFailure("prov", new Error("timeout"), undefined, T0);
		recordFailure("prov", new Error("timeout"), undefined, T0 + 300_001);
		expect(breakerState("prov", T0 + 300_001)).toEqual({ open: false });
	});

	it("tracks providers independently", () => {
		recordFailure("a", new Error("timeout"), undefined, T0);
		recordFailure("a", new Error("timeout"), undefined, T0);
		expect(breakerState("b", T0).open).toBe(false);
		expect(breakerState("a", T0).open).toBe(true);
	});

	it("resetBreakerForTests clears all provider state", () => {
		recordFailure("prov", new Error("timeout"), undefined, T0);
		recordFailure("prov", new Error("timeout"), undefined, T0);
		resetBreakerForTests();
		expect(breakerState("prov", T0)).toEqual({ open: false });
	});
});
