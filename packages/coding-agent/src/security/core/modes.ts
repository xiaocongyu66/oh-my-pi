/**
 * Permission mode cycling, ported from Claude Code's getNextPermissionMode.
 * UI-agnostic: the host decides which modes are available in its session.
 */

import type { PermissionMode } from "./types";

export type ModeAvailability = {
	/** bypassPermissions is enabled by policy for this session. */
	bypassAvailable: boolean;
	/** The auto mode classifier is configured and enabled. */
	classifierAvailable: boolean;
};

/**
 * Interactive cycle order. dontAsk is entered/left via explicit settings,
 * never via the shift-tab style cycle.
 */
export function nextPermissionMode(mode: PermissionMode, availability: ModeAvailability): PermissionMode {
	switch (mode) {
		case "default":
			return "acceptEdits";
		case "acceptEdits":
			return "plan";
		case "plan":
			if (availability.classifierAvailable) {
				return "auto";
			}
			return availability.bypassAvailable ? "bypassPermissions" : "default";
		case "auto":
			return availability.bypassAvailable ? "bypassPermissions" : "default";
		case "bypassPermissions":
		case "dontAsk":
			return "default";
	}
}

/** Human-readable one-liners for prompts and status lines. */
export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
	default: "Ask before anything not covered by a permission rule",
	acceptEdits: "Auto-approve file edits in the workspace; ask before running commands",
	plan: "Planning mode: read-only intent, no exec",
	bypassPermissions: "Bypass: allow all tool calls except bypass-immune safety checks",
	dontAsk: "Never prompt: every otherwise-ask decision is denied",
	auto: "Auto: unresolved asks go to the safety classifier",
};
