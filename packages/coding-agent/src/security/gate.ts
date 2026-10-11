/**
 * Host adapter for the Claude-Code-style permission engine. Builds a
 * `PermissionCheckContext` from session settings, runs the decision flow, and
 * renders the interactive prompt for asks that carry a content-level basis
 * (explicit ask rules, safety checks, classifier reasons).
 *
 * An ask with no decision reason means the engine had nothing to say about
 * this call — the host's legacy tier gate stays in charge (`undefined`).
 */

import { t } from "@oh-my-pi/pi-i18n";

import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import { serializeTranscript } from "./classifier/transcript";
import type { YoloClassifierHook } from "./classifier/yolo-classifier";
import { createDenialTrackingState } from "./core/denialTracking";
import { checkPermission, HEADLESS_PROMPT_UNAVAILABLE_REASON } from "./core/decision";
import { stripDangerousAllowRules } from "./core/permissionSetup";
import { collectPermissionRules } from "./core/rulesLoader";
import {
	bypassWasSessionOrigin,
	cfgPermissionsAdditionalDirectories,
	cfgPermissionsAllow,
	cfgPermissionsAsk,
	cfgPermissionsDeny,
	cfgSandboxAllowedDomains,
	cfgSandboxAutoAllowBashIfSandboxed,
	cfgSandboxEnabled,
	cfgSandboxExcludedCommands,
	resolvePermissionMode,
} from "./settings";
import { createSandboxAutoAllow } from "./sandbox/autoAllow";
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
	/**
	 * The host already holds an explicit approval for this exact input (ACP
	 * grant, xd:// grant). Prompt-shaped engine outcomes (asks and the headless
	 * conversion of an ask) defer to the host instead of binding; rule and
	 * safety-check denials still apply.
	 */
	hostApproved?: boolean;
	/** Host capability for the auto-mode classifier (omitted → auto prompts). */
	classifierDeps?: CcClassifierDeps;
};

export type CcClassifierDeps = {
	modelRegistry: ModelRegistry;
	getModel: () => unknown;
	getMessages: () => readonly unknown[];
};

/** Per-session denial-tracking state, keyed by the settings instance. */
const denialStates = new WeakMap<Settings, DenialTrackingState>();

/** Per-session auto-mode classifier hook, built once from host model deps. */
const classifierHooks = new WeakMap<Settings, Promise<YoloClassifierHook | undefined>>();

function buildClassifierHook(settings: Settings, deps: CcClassifierDeps): Promise<YoloClassifierHook | undefined> {
	return (
		classifierHooks.get(settings) ??
		(async () => {
			try {
				const { resolveRoleSelection } = await import("../config/model-resolver");
				const { createYoloClassifier } = await import("./classifier/yolo-classifier");
				const model =
					resolveRoleSelection(["smol"], settings, deps.modelRegistry.getAvailable())?.model ?? deps.getModel();
				if (!model) return undefined;
				const apiKey = await deps.modelRegistry.getApiKey(model as never);
				if (!apiKey) return undefined;
				return createYoloClassifier({
					piModel: model,
					piApiKey: deps.modelRegistry.resolver(model as never),
					buildTranscript: () => serializeTranscript(deps.getMessages()),
				});
			} catch {
				// Classifier wiring failed (no smol role, no credential, import
				// error). Fail open: auto mode keeps prompting like default.
				return undefined;
			}
		})()
	);
}

/** Lazily-built sandbox auto-allow predicate; rebuilt when its settings change. */
const sandboxCache = new WeakMap<
	Settings,
	{ key: string; canAutoAllow: NonNullable<PermissionCheckContext["canSandboxAutoAllow"]> }
>();

function sandboxAutoAllow(settings: Settings): NonNullable<PermissionCheckContext["canSandboxAutoAllow"]> | undefined {
	if (!cfgSandboxEnabled.get(settings)) {
		return undefined;
	}
	const autoAllow = cfgSandboxAutoAllowBashIfSandboxed.get(settings);
	const excluded = cfgSandboxExcludedCommands.get(settings);
	const domains = cfgSandboxAllowedDomains.get(settings);
	const key = JSON.stringify([autoAllow, excluded, domains]);
	const cached = sandboxCache.get(settings);
	if (cached?.key === key) {
		return cached.canAutoAllow;
	}
	const created = createSandboxAutoAllow({
		enabled: true,
		autoAllowBashIfSandboxed: autoAllow,
		excludedCommands: excluded,
		allowedDomains: domains,
	});
	sandboxCache.set(settings, { key, canAutoAllow: created.canSandboxAutoAllow });
	return created.canSandboxAutoAllow;
}

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
	// Plan mode keeps CC's bypass carry-over only for yolo-origin sessions;
	// see bypassWasSessionOrigin.
	const bypassOrigin = bypassWasSessionOrigin(settings);
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
		isBypassPermissionsModeAvailable: bypassOrigin,
		checkTool: runToolChecks,
	};
	if (mode === "auto") {
		const state = denialStates.get(settings) ?? createDenialTrackingState();
		ctx.denial = {
			state,
			persist: next => denialStates.set(settings, next),
		};
		if (request.classifierDeps) {
			let hook = classifierHooks.get(settings);
			if (!hook) {
				hook = buildClassifierHook(settings, request.classifierDeps);
				classifierHooks.set(settings, hook);
			}
			const classifier = await hook;
			if (classifier) {
				ctx.classifier = classifier;
			}
		}
	}
	const canSandboxAutoAllow = sandboxAutoAllow(settings);
	if (canSandboxAutoAllow) {
		ctx.canSandboxAutoAllow = canSandboxAutoAllow;
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
	// re-probe interactively to see whether the underlying ask was unremarkable
	// — including working-directory-boundary asks, whose posture the host's
	// tiers own (interactive sessions still get the engine's grant prompt).
	if (
		ctx.classifier === undefined &&
		decision.behavior === "deny" &&
		decision.decisionReason.type === "other" &&
		decision.decisionReason.reason === HEADLESS_PROMPT_UNAVAILABLE_REASON
	) {
		const probe = await checkPermission(request.toolName, request.input, { ...ctx, isInteractive: true }, options);
		if (
			probe.behavior === "ask" &&
			(probe.decisionReason === undefined || probe.decisionReason.type === "workingDir")
		) {
			return undefined;
		}
	}
	// An explicit host grant (ACP / xd:// approval of this exact input)
	// supersedes prompt-shaped engine outcomes; denials still bind.
	if (
		request.hostApproved &&
		(decision.behavior === "ask" ||
			(decision.behavior === "deny" &&
				decision.decisionReason?.type === "other" &&
				decision.decisionReason.reason === HEADLESS_PROMPT_UNAVAILABLE_REASON))
	) {
		return undefined;
	}
	return decision;
}

export type CcPromptOutcome = "approve" | "approve-always" | "deny";

const APPROVE = () => t("Yes");
const APPROVE_ALWAYS_PREFIX = () => t("Yes, and always allow");
const DENY_WITH_FEEDBACK_PREFIX = () => t("No, and explain what to do instead");

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
	const options = [APPROVE(), `${APPROVE_ALWAYS_PREFIX()} ${toolName}`, DENY_WITH_FEEDBACK_PREFIX(), t("No")];
	const choice = await ui.select(ask.message, options);
	if (choice === APPROVE()) {
		return "approve";
	}
	if (choice?.startsWith(APPROVE_ALWAYS_PREFIX())) {
		persistAlwaysAllow(settings, toolName);
		return "approve-always";
	}
	if (choice?.startsWith(DENY_WITH_FEEDBACK_PREFIX())) {
		await ui.input(t("Feedback for {{tool}}", { tool: toolName }), t("What should be done instead?"));
	}
	return "deny";
}

/** Persist a tool-wide allow rule into the global permission allow list. */
export function persistAlwaysAllow(settings: Settings, toolName: string): void {
	cfgPermissionsAllow.setMember(settings, toolName, { member: true });
}
