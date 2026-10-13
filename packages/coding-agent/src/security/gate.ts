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
import { appendPermissionRule } from "../discovery/claude-write";
import { listMemorySources, resolveWriteTarget, type ClaudeSharedMode } from "../memory/claudemd-backend/paths";
import { cfgMemoryClaudeShared } from "../memory-backend/settings";
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
	/**
	 * Session working directory. Used to resolve the CC auto-memory directories
	 * for the file-tool carve-out (CC isAutoMemPath parity); omitted → no
	 * memory carve-out (all memory prompts fall to the normal flow).
	 */
	cwd?: string;
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
const memoryDirsCache = new WeakMap<Settings, Map<string, { write: readonly string[]; read: readonly string[] }>>();

/**
 * Resolve the memory carve-out dirs (CC isAutoMemPath parity). Cached per
 * (settings, cwd): the backend re-resources per use to catch mid-session
 * interop flips, while the gate only needs a stable enough exempt set — the
 * probes are stat walks we refuse to run on every file tool call.
 */
async function memoryExemptDirectories(
	settings: Settings,
	cwd: string,
): Promise<{ write: readonly string[]; read: readonly string[] }> {
	let perCwd = memoryDirsCache.get(settings);
	if (!perCwd) {
		perCwd = new Map();
		memoryDirsCache.set(settings, perCwd);
	}
	const cached = perCwd.get(cwd);
	if (cached) return cached;
	let dirs: { write: readonly string[]; read: readonly string[] } = { write: [], read: [] };
	try {
		let shared: ClaudeSharedMode = "auto";
		try {
			shared = cfgMemoryClaudeShared.get(settings);
		} catch {
			/* partial settings (tests) — default to auto, as the backend does */
		}
		const sources = await listMemorySources({ agentDir: settings.getAgentDir(), projectDir: cwd, shared });
		dirs = { write: [resolveWriteTarget(sources)], read: sources.map(source => source.dir) };
	} catch {
		// Memory interop must never affect a permission decision.
	}
	perCwd.set(cwd, dirs);
	return dirs;
}

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
	if (request.cwd) {
		ctx.memoryDirectories = await memoryExemptDirectories(settings, request.cwd);
	}
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
const APPROVE_ALWAYS_PROJECT_PREFIX = () => t("Yes, and always allow in this project");
const DENY_WITH_FEEDBACK_PREFIX = () => t("No, and explain what to do instead");

/**
 * Render the CC-style prompt for an engine ask and persist the always-allow
 * choice when picked: the project destination writes a tool-wide allow rule
 * into `<projectDir>/.claude/settings.local.json` (shared with Claude Code),
 * while the legacy destination keeps writing the global `permissions.allow`
 * list. Both always-allow picks report back as `"approve-always"`.
 *
 * `projectDir` (the session cwd) enables the project option; callers without
 * a project context get the original four-option prompt.
 */
export async function promptCcPermission(
	ui: ExtensionUIContext,
	settings: Settings,
	toolName: string,
	ask: PermissionAskDecision,
	projectDir?: string,
): Promise<CcPromptOutcome> {
	const options = [
		APPROVE(),
		`${APPROVE_ALWAYS_PREFIX()} ${toolName}`,
		...(projectDir ? [`${APPROVE_ALWAYS_PROJECT_PREFIX()} ${toolName}`] : []),
		DENY_WITH_FEEDBACK_PREFIX(),
		t("No"),
	];
	const choice = await ui.select(ask.message, options);
	if (choice === APPROVE()) {
		return "approve";
	}
	// Matched before the global prefix on purpose: the project label starts
	// with the global label's text.
	if (projectDir && choice?.startsWith(APPROVE_ALWAYS_PROJECT_PREFIX())) {
		await persistProjectAlwaysAllow(ui, projectDir, toolName);
		return "approve-always";
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

/**
 * Persist a tool-wide allow rule into `<projectDir>/.claude/settings.local.json`
 * (the destination Claude Code shares). Persistence failures never throw —
 * the tool call is already approved for this session; the user just gets a
 * notification that the project-level rule could not be saved.
 */
async function persistProjectAlwaysAllow(ui: ExtensionUIContext, projectDir: string, toolName: string): Promise<void> {
	const result = await appendPermissionRule(projectDir, "allow", [toolName]);
	if (result.error) {
		ui.notify(t("Failed to save project permission: {{error}}", { error: result.error.message }), "error");
	}
}
