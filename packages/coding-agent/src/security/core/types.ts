/**
 * Pure permission type contracts for the rule-based permission engine.
 *
 * Ported from Claude Code's permission type model: allow/deny/ask rules are
 * evaluated ahead of the host agent's tier-based approval fallback. Modules in
 * this directory must stay free of imports outside `./` — the engine is pure
 * and unit-testable without an agent session.
 */

// ============================================================================
// Permission Modes
// ============================================================================

/**
 * User-addressable permission modes.
 * - `default`            — ask before anything not covered by a rule.
 * - `acceptEdits`        — file edits auto-approved; exec still prompts.
 * - `plan`               — read-only intent; gates like default, plus a bypass-availability flag.
 * - `bypassPermissions`  — allow everything except bypass-immune checks.
 * - `dontAsk`            — every prompt turns into a deny (headless hardening).
 * - `auto`               — unresolved asks may be resolved by a configured
 *                          classifier; without one it prompts like `default`.
 */
export const PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto"] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

const PERMISSION_MODE_SET: ReadonlySet<string> = new Set(PERMISSION_MODES);

export function isPermissionMode(value: unknown): value is PermissionMode {
	return typeof value === "string" && PERMISSION_MODE_SET.has(value);
}

// ============================================================================
// Permission Behaviors
// ============================================================================

export type PermissionBehavior = "allow" | "deny" | "ask";

const PERMISSION_BEHAVIOR_SET: ReadonlySet<string> = new Set(["allow", "deny", "ask"]);

export function isPermissionBehavior(value: unknown): value is PermissionBehavior {
	return typeof value === "string" && PERMISSION_BEHAVIOR_SET.has(value);
}

// ============================================================================
// Permission Rules
// ============================================================================

/** Where a permission rule originated from. Mirrors the host settings layers. */
export type PermissionRuleSource = "env" | "runtime" | "project" | "global" | "session";

/** The value of a permission rule — tool name plus optional content pattern. */
export type PermissionRuleValue = {
	toolName: string;
	ruleContent?: string;
};

/** A permission rule with its source and behavior. */
export type PermissionRule = {
	source: PermissionRuleSource;
	ruleBehavior: PermissionBehavior;
	ruleValue: PermissionRuleValue;
};

// ============================================================================
// Permission Updates
// ============================================================================

/** Where a permission update should be persisted. */
export type PermissionUpdateDestination = "global" | "project" | "session";

/** Update operations for permission configuration (used by "always allow" flows). */
export type PermissionUpdate =
	| {
			type: "addRules";
			destination: PermissionUpdateDestination;
			rules: PermissionRuleValue[];
			behavior: PermissionBehavior;
	  }
	| {
			type: "replaceRules";
			destination: PermissionUpdateDestination;
			rules: PermissionRuleValue[];
			behavior: PermissionBehavior;
	  }
	| {
			type: "removeRules";
			destination: PermissionUpdateDestination;
			rules: PermissionRuleValue[];
			behavior: PermissionBehavior;
	  }
	| {
			type: "setMode";
			destination: PermissionUpdateDestination;
			mode: PermissionMode;
	  }
	| {
			type: "addDirectories";
			destination: PermissionUpdateDestination;
			directories: string[];
	  }
	| {
			type: "removeDirectories";
			destination: PermissionUpdateDestination;
			directories: string[];
	  };

/** An additional directory included in the permission working scope. */
export type AdditionalWorkingDirectory = {
	path: string;
	source: PermissionRuleSource;
};

// ============================================================================
// Permission Decisions & Results
// ============================================================================

/** Result when permission is granted. */
export type PermissionAllowDecision = {
	behavior: "allow";
	/** Tool input substitutions to apply before execution (e.g. sandboxed command). */
	updatedInput?: Record<string, unknown>;
	decisionReason?: PermissionDecisionReason;
	toolUseId?: string;
	acceptFeedback?: string;
};

/** Result when the user should be prompted. */
export type PermissionAskDecision = {
	behavior: "ask";
	message: string;
	updatedInput?: Record<string, unknown>;
	decisionReason?: PermissionDecisionReason;
	suggestions?: PermissionUpdate[];
	blockedPath?: string;
};

/** Result when permission is denied. */
export type PermissionDenyDecision = {
	behavior: "deny";
	message: string;
	decisionReason: PermissionDecisionReason;
	toolUseId?: string;
};

export type PermissionDecision = PermissionAllowDecision | PermissionAskDecision | PermissionDenyDecision;

/** Permission result with the additional passthrough option. */
export type PermissionResult =
	| PermissionDecision
	| {
			behavior: "passthrough";
			message: string;
			decisionReason?: PermissionDecisionReason;
			suggestions?: PermissionUpdate[];
			blockedPath?: string;
	  };

/** Explanation of why a permission decision was made. */
export type PermissionDecisionReason =
	| { type: "rule"; rule: PermissionRule }
	| { type: "mode"; mode: PermissionMode }
	| { type: "subcommandResults"; reasons: Map<string, PermissionResult> }
	| { type: "hook"; hookName: string; hookSource?: string; reason?: string }
	| { type: "sandboxOverride"; reason: "excludedCommand" | "dangerouslyDisableSandbox" }
	| { type: "classifier"; classifier: string; reason: string }
	| { type: "workingDir"; reason: string }
	| {
			type: "safetyCheck";
			reason: string;
			/**
			 * When true an auto-mode classifier may resolve the prompt instead of
			 * forcing the user. False for path-bypass attempts, which are never
			 * classifier-approvable.
			 */
			classifierApprovable: boolean;
	  }
	| { type: "other"; reason: string };

// ============================================================================
// Classifier Contracts (opt-in auto mode)
// ============================================================================

export type ClassifierResult = {
	behavior: "allow" | "ask" | "deny";
	reason: string;
	confidence: "high" | "medium" | "low";
	/** Set when the classifier could not run (API error, transcript too long). */
	unavailable?: boolean;
};

// ============================================================================
// Denial Tracking
// ============================================================================

export type DenialTrackingState = {
	consecutiveDenials: number;
	totalDenials: number;
};

// ============================================================================
// Permission Evaluation Context
// ============================================================================

/** Rules grouped by behavior, pre-parsed from every configured source. */
export type ParsedRules = {
	allow: PermissionRule[];
	deny: PermissionRule[];
	ask: PermissionRule[];
};

/** A tool-provided permission check (content-dependent rules for a tool). */
export type ToolPermissionCheck = (
	toolName: string,
	input: Record<string, unknown>,
	context: PermissionCheckContext,
) => PermissionResult | Promise<PermissionResult>;

/** Everything the decision flow needs, injected by the host — no ambient state. */
export type PermissionCheckContext = {
	mode: PermissionMode;
	rules: ParsedRules;
	/** Directories the agent may treat as its workspace (beyond the tool's own cwd). */
	workingDirectories: ReadonlyMap<string, AdditionalWorkingDirectory>;
	/** True when an interactive user can answer prompts. */
	isInteractive: boolean;
	/** True when bypassPermissions mode is allowed by policy (not disabled). */
	isBypassPermissionsModeAvailable: boolean;
	/**
	 * The agent's own configuration directory, for the agent-config-file write
	 * gate (CC's isClaudeConfigFilePath parity). Defaults to the host's
	 * `getAgentDir()`; overridable so tests can exercise relocated agent dirs.
	 */
	agentDir?: string;
	/**
	 * Memory directories exempt from file-tool prompts — CC's `isAutoMemPath`
	 * carve-outs (filesystem.ts:1574-1605 write, :1717-1728 read). `write`
	 * holds the active memory write target (auto-allowed pre-safety-gate, like
	 * CC's pre-safety-check carve-out for `~/.claude`'s DANGEROUS_DIRECTORIES
	 * membership); `read` additionally covers read-only memory sources omp
	 * merges (CC has a single memory dir, omp's multi-source design needs the
	 * wider read set). Pre-resolved absolute paths.
	 */
	memoryDirectories?: { readonly write: readonly string[]; readonly read: readonly string[] };
	/**
	 * Sandbox auto-allow probe: true when this exact call would run inside an
	 * OS sandbox that the user has configured to auto-allow. Checked at step 1b.
	 */
	canSandboxAutoAllow?: (toolName: string, input: Record<string, unknown>) => boolean;
	/** Per-tool content checks; unregistered tools fall through to rule/mode flow. */
	checkTool?: ToolPermissionCheck;
	/** Whether the tool demands explicit user interaction even on allow rules. */
	requiresUserInteraction?: (toolName: string) => boolean;
	/**
	 * Optional classifier for `auto` mode. Only consulted when the host enables
	 * `permissions.classifier`; without it `auto` prompts like `default`.
	 * Returning `undefined` means the classifier was unavailable.
	 */
	classifier?: (
		toolName: string,
		input: Record<string, unknown>,
		ask: PermissionAskDecision,
	) => Promise<ClassifierResult | undefined>;
	/** Mutable denial-tracking state + its persistence hook (auto mode). */
	denial?: {
		state: DenialTrackingState;
		persist: (state: DenialTrackingState) => void;
	};
	/**
	 * Tools whose checkPermissions would return `allow` under acceptEdits for
	 * reasons the classifier must still see (subagent dispatch, eval glue).
	 * They skip the acceptEdits fast-path re-invocation.
	 */
	skipAcceptEditsFastPath?: (toolName: string) => boolean;
	/** Safe tools that skip classifier calls entirely (auto-mode allowlist). */
	isOnSafeAllowlist?: (toolName: string) => boolean;
};
