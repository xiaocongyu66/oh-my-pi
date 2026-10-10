/**
 * Denial tracking for auto-mode classifier decisions, ported from Claude Code.
 * Consecutive/total classifier denials beyond the limits make the flow fall
 * back to explicit user prompting instead of looping on auto-denials.
 */

import type { DenialTrackingState } from "./types";

export const DENIAL_LIMITS = {
	maxConsecutive: 3,
	maxTotal: 20,
} as const;

export function createDenialTrackingState(): DenialTrackingState {
	return { consecutiveDenials: 0, totalDenials: 0 };
}

export function recordDenial(state: DenialTrackingState): DenialTrackingState {
	return {
		consecutiveDenials: state.consecutiveDenials + 1,
		totalDenials: state.totalDenials + 1,
	};
}

/** Returns the same reference when already clean, letting callers skip writes. */
export function recordSuccess(state: DenialTrackingState): DenialTrackingState {
	if (state.consecutiveDenials === 0) {
		return state;
	}
	return { ...state, consecutiveDenials: 0 };
}

/** True when denials exceeded a limit and the user should be prompted. */
export function shouldFallbackToPrompting(state: DenialTrackingState): boolean {
	return state.consecutiveDenials >= DENIAL_LIMITS.maxConsecutive || state.totalDenials >= DENIAL_LIMITS.maxTotal;
}
