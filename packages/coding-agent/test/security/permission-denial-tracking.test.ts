/**
 * Contract: auto-mode denial tracking escalates to explicit prompting once
 * consecutive or total classifier denials cross the limits, and any success
 * clears the consecutive streak.
 */
import { describe, expect, test } from "bun:test";
import {
	createDenialTrackingState,
	DENIAL_LIMITS,
	recordDenial,
	recordSuccess,
	shouldFallbackToPrompting,
} from "../../src/security/core/denialTracking";
import type { DenialTrackingState } from "../../src/security/core/types";

describe("denial tracking", () => {
	test("fresh state is below every limit", () => {
		const state = createDenialTrackingState();
		expect(state).toEqual({ consecutiveDenials: 0, totalDenials: 0 });
		expect(shouldFallbackToPrompting(state)).toBe(false);
	});

	test("denials increment both counters", () => {
		let state = createDenialTrackingState();
		state = recordDenial(state);
		state = recordDenial(state);
		expect(state).toEqual({ consecutiveDenials: 2, totalDenials: 2 });
		expect(shouldFallbackToPrompting(state)).toBe(false);
	});

	test("consecutive limit triggers fallback", () => {
		let state = createDenialTrackingState();
		for (let i = 0; i < DENIAL_LIMITS.maxConsecutive; i++) state = recordDenial(state);
		expect(shouldFallbackToPrompting(state)).toBe(true);
	});

	test("total limit triggers fallback even with a reset streak", () => {
		let state: DenialTrackingState = { consecutiveDenials: 0, totalDenials: DENIAL_LIMITS.maxTotal };
		expect(shouldFallbackToPrompting(state)).toBe(true);
		state = recordSuccess(state);
		expect(shouldFallbackToPrompting(state)).toBe(true);
	});

	test("success clears the streak but not the total", () => {
		const dirty = { consecutiveDenials: 2, totalDenials: 7 };
		expect(recordSuccess(dirty)).toEqual({ consecutiveDenials: 0, totalDenials: 7 });
	});

	test("success on a clean state returns the same reference", () => {
		const clean = createDenialTrackingState();
		expect(recordSuccess(clean)).toBe(clean);
	});
});
