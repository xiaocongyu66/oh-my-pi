/**
 * Permission and sandbox settings domain (see `config/registry.ts`). The rule
 * lists feed the Claude-Code-style decision engine in `security/core`;
 * `config/all-settings.ts` registers this domain for the settings panel.
 *
 * Rule strings use Claude Code syntax: `Bash(git diff:*)`, `Read(./.env)`,
 * `Write(~/.ssh/**)`, or a bare tool name for a tool-wide rule. Tool names are
 * case-insensitive and PascalCase Claude Code names are aliased to the host's
 * lowercase names (see `core/ruleParser.ts`).
 */

import { register } from "../config/registry";
import type { Settings } from "../config/settings";
import { cfgToolsApprovalMode } from "../tools/settings";
import { isPermissionMode, type PermissionMode } from "./core/types";

const EMPTY_STRING_ARRAY: readonly string[] = [];

// Allow rules: calls matching these skip the prompt entirely (unless a
// bypass-immune step — content ask rules, safety checks — fires first).
export const cfgPermissionsAllow = register({
	id: "permissions.allow",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	ui: {
		tab: "interaction",
		group: "Permissions",
		label: "Permission Allow Rules",
		description:
			"Rules auto-approving tool calls, e.g. Bash(git diff:*), Read(./.env), WebFetch. Bare tool names apply tool-wide.",
	},
});

// Deny rules: matched calls are rejected without prompting, in every mode.
export const cfgPermissionsDeny = register({
	id: "permissions.deny",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	ui: {
		tab: "interaction",
		group: "Permissions",
		label: "Permission Deny Rules",
		description: "Rules blocking tool calls outright, e.g. Bash(rm -rf:*), Read(./.env), Bash(sudo:*).",
	},
});

// Ask rules: matched calls always prompt, even under bypass modes.
export const cfgPermissionsAsk = register({
	id: "permissions.ask",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	ui: {
		tab: "interaction",
		group: "Permissions",
		label: "Permission Ask Rules",
		description: "Rules that always require confirmation, e.g. Bash(git push:*), Write(~/.ssh/**).",
	},
});

// Explicit permission mode: "" derives from the legacy tools.approvalMode
// mapping (always-ask→default, write→acceptEdits, yolo→bypassPermissions).
// An empty default is deliberate: the legacy setting is a string enum and the
// derived mode depends on bypass/classifier availability at read time.
export const cfgPermissionsDefaultMode = register({
	id: "permissions.defaultMode",
	type: "string",
	default: "",
	ui: {
		tab: "interaction",
		group: "Permissions",
		label: "Permission Mode",
		description:
			"One of default, acceptEdits, plan, bypassPermissions, dontAsk, auto. Empty derives from the legacy tools.approvalMode.",
	},
});

// Extra directories treated as workspace by path safety checks.
export const cfgPermissionsAdditionalDirectories = register({
	id: "permissions.additionalDirectories",
	type: "array",
	default: EMPTY_STRING_ARRAY,
});

// Policy kill-switch for bypass mode (also downgrades legacy yolo).
export const cfgPermissionsDisableBypass = register({
	id: "permissions.disableBypassPermissionsMode",
	type: "boolean",
	default: false,
});

// CC's bash step 7 auto-allows strictly read-only commands; this port is
// enabled by default (CC parity). Set permissions.bashReadOnlyAutoAllow to
// false to restore omp's stricter posture of prompting for every bash
// command in ask-preserving modes.
export const cfgPermissionsBashReadOnlyAutoAllow = register({
	id: "permissions.bashReadOnlyAutoAllow",
	type: "boolean",
	default: true,
});

// CC parity: auto mode resolves unresolved asks through the LLM permission
// classifier by default. Set permissions.classifier to false to make auto
// prompt like default (the legacy opt-in posture).
export const cfgPermissionsClassifier = register({
	id: "permissions.classifier",
	type: "boolean",
	default: true,
});

export const cfgSandboxEnabled = register({
	id: "sandbox.enabled",
	type: "boolean",
	default: false,
});

export const cfgSandboxAutoAllowBashIfSandboxed = register({
	id: "sandbox.autoAllowBashIfSandboxed",
	type: "boolean",
	default: true,
});

export const cfgSandboxExcludedCommands = register({
	id: "sandbox.excludedCommands",
	type: "array",
	default: EMPTY_STRING_ARRAY,
});

export const cfgSandboxAllowedDomains = register({
	id: "sandbox.network.allowedDomains",
	type: "array",
	default: EMPTY_STRING_ARRAY,
});

/** Policy availability of the bypass and auto modes. */
export function modeAvailability(settings: Settings): {
	bypassAvailable: boolean;
	classifierAvailable: boolean;
} {
	return {
		bypassAvailable: !cfgPermissionsDisableBypass.get(settings),
		classifierAvailable: cfgPermissionsClassifier.get(settings),
	};
}

/**
 * CC grants plan-mode auto-approval only to sessions that *started* in a
 * bypass posture (`mode === 'plan' && isBypassPermissionsModeAvailable`,
 * i.e. shift-tab from bypass into plan). The config equivalent of "started in
 * bypass" is the legacy `yolo` approval mode; an explicit `plan` mode from an
 * ask-first origin is a genuine read-only intent and gets no bypass carry-over.
 */
export function bypassWasSessionOrigin(settings: Settings): boolean {
	return modeAvailability(settings).bypassAvailable && cfgToolsApprovalMode.get(settings) === "yolo";
}

/**
 * Effective permission mode: an explicit `permissions.defaultMode` wins;
 * otherwise the legacy `tools.approvalMode` is mapped. Modes blocked by policy
 * (disabled bypass, unconfigured classifier) fall back to `default`.
 */
export function resolvePermissionMode(settings: Settings): PermissionMode {
	const { bypassAvailable, classifierAvailable } = modeAvailability(settings);
	const explicit = cfgPermissionsDefaultMode.get(settings).trim();
	if (explicit !== "" && isPermissionMode(explicit)) {
		if (explicit === "bypassPermissions" && !bypassAvailable) return "default";
		if (explicit === "auto" && !classifierAvailable) return "default";
		return explicit;
	}
	const legacy = cfgToolsApprovalMode.get(settings);
	if (legacy === "yolo") return bypassAvailable ? "bypassPermissions" : "default";
	if (legacy === "write") return "acceptEdits";
	return "default";
}
