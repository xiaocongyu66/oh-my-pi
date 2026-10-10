/**
 * Host adapter for the Claude-Code-style permission engine. Builds a
 * `PermissionCheckContext` from session settings, runs the decision flow, and
 * renders the interactive prompt for asks that carry a content-level basis
 * (explicit ask rules, safety checks, classifier reasons).
 *
 * An ask with no decision reason means the engine had nothing to say about
 * this call — the host's legacy tier gate stays in charge (`undefined`).
 */

import type { Settings } from "../config/settings";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import { createDenialTrackingState } from "./core/denialTracking";
import { checkPermission, HEADLESS_PROMPT_UNAVAILABLE_REASON } from "./core/decision";
import { stripDangerousAllowRules } from "./core/permissionSetup";
import { collectPermissionRules } from "./core/rulesLoader";
import {
	cfgPermissionsAdditionalDirectories,
	cfgPermissionsAllow,
	cfgPermissionsAsk,
	cfgPermissionsDeny,
	modeAvailability,
	resolvePermissionMode,
} from "./settings";
import { bashToolCheckPermission } from "./bash-check";
import { checkFileToolPermission } from "./file-checks";
import { registerToolCheck, runToolChecks } from "./tool-checks";
import type {
	AdditionalWorkingDirectory,
	DenialTrackingState,
	PermissionAskDecision,
	PermissionCheckContext,
	PermissionDecision,
} from "./core/types";

// Content checks for the tools that have them; every other tool stays
// passthrough and is decided by rules + mode + the host tier gate.
registerToolCheck("bash", bashToolCheckPermission);
for (const fileTool of ["read", "glob", "grep", "find", "list", "edit", "write", "ast_edit", "notebook_edit"]) {
	registerToolCheck(fileTool, checkFileToolPermission);
}

export type CcGateRequest = {
	toolName: string;
	input: Record<string, unknown>;
	settings: Settings | undefined;
	isInteractive: boolean;
	toolUseId?: string;
};

/** Per-session denial-tracking state, keyed by the settings instance. */
const denialStates = new WeakMap<Settings, DenialTrackingState>();

/**
 * Evaluate a tool call against rules and mode. Returns `undefined` when the
 * engine defers to the host's tier gate (no settings, or an unremarkable
 * passthrough ask); otherwise a binding allow/deny/ask decision.
 */
export async function evaluateCcPermissions(request: CcGateRequest): Promise<PermissionDecision | undefined> {
	const { settings } = request;
	if (!settings) {
		return undefined;
	}
	const mode = resolvePermissionMode(settings);
	const { bypassAvailable } = modeAvailability(settings);
	let rules = collectPermissionRules([
		{
			source: "project",
			allow: cfgPermissionsAllow.get(settings),
			deny: cfgPermissionsDeny.get(settings),
			ask: cfgPermissionsAsk.get(settings),
		},
	]);
	// Auto mode must not smuggle arbitrary-code-execution allows past the
	// classifier; stripped rules are simply absent while the mode is active.
	if (mode === "auto") {
		rules = stripDangerousAllowRules(rules).rules;
	}
	const workingDirectories = new Map<string, AdditionalWorkingDirectory>();
	for (const path of cfgPermissionsAdditionalDirectories.get(settings)) {
		workingDirectories.set(path, { path, source: "project" });
	}
	const ctx: PermissionCheckContext = {
		mode,
		rules,
		workingDirectories,
		isInteractive: request.isInteractive,
		isBypassPermissionsModeAvailable: bypassAvailable,
		checkTool: runToolChecks,
	};
	if (mode === "auto") {
		const state = denialStates.get(settings) ?? createDenialTrackingState();
		ctx.denial = {
			state,
			persist: next => denialStates.set(settings, next),
		};
	}
	const options = request.toolUseId ? { toolUseId: request.toolUseId } : undefined;
	const decision = await checkPermission(request.toolName, request.input, ctx, options);
	// Passthrough-derived asks (no content-level reason) defer to the host's
	// tier approval — the engine only enforces what it can actually judge.
	if (decision.behavior === "ask" && decision.decisionReason === undefined) {
		return undefined;
	}
	// A headless host converts every ask to a deny. The tier gate has its own
	// tier-aware headless policy (reads auto-approve, exec fails closed), so
	// re-probe interactively to see whether the underlying ask was unremarkable.
	if (
		ctx.classifier === undefined &&
		decision.behavior === "deny" &&
		decision.decisionReason.type === "other" &&
		decision.decisionReason.reason === HEADLESS_PROMPT_UNAVAILABLE_REASON
	) {
		const probe = await checkPermission(request.toolName, request.input, { ...ctx, isInteractive: true }, options);
		if (probe.behavior === "ask" && probe.decisionReason === undefined) {
			return undefined;
		}
	}
	return decision;
}

export type CcPromptOutcome = "approve" | "approve-always" | "deny";

const APPROVE = "Yes";
const APPROVE_ALWAYS_PREFIX = "Yes, and always allow";
const DENY_WITH_FEEDBACK_PREFIX = "No, and explain what to do instead";

/**
 * Render the CC-style four-option prompt for an engine ask and persist the
 * always-allow choice into `permissions.allow` when picked.
 */
export async function promptCcPermission(
	ui: ExtensionUIContext,
	settings: Settings,
	toolName: string,
	ask: PermissionAskDecision,
): Promise<CcPromptOutcome> {
	const options = [APPROVE, `${APPROVE_ALWAYS_PREFIX} ${toolName}`, DENY_WITH_FEEDBACK_PREFIX, "No"];
	const choice = await ui.select(ask.message, options);
	if (choice === APPROVE) {
		return "approve";
	}
	if (choice?.startsWith(APPROVE_ALWAYS_PREFIX)) {
		persistAlwaysAllow(settings, toolName);
		return "approve-always";
	}
	if (choice?.startsWith(DENY_WITH_FEEDBACK_PREFIX)) {
		await ui.input(`Feedback for ${toolName}`, "What should be done instead?");
	}
	return "deny";
}

/** Persist a tool-wide allow rule into the global permission allow list. */
export function persistAlwaysAllow(settings: Settings, toolName: string): void {
	cfgPermissionsAllow.setMember(settings, toolName, { member: true });
}
