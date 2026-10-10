/**
 * Rule-based permission decision flow, ported from Claude Code's
 * `hasPermissionsToUseTool`. Evaluation order inside the tool gate:
 *
 *   1a tool-wide deny rule
 *   1b tool-wide ask rule            (skippable via sandbox auto-allow)
 *   1c tool.checkPermissions         (content-dependent checks)
 *   1d tool deny
 *   1e requiresUserInteraction + ask (bypass-immune)
 *   1f content-specific ask rule     (bypass-immune — user explicitly configured)
 *   1g safetyCheck ask               (bypass-immune — .git/, shell configs, ...)
 *   2a bypass modes (bypassPermissions, plan-with-bypass)
 *   2b tool-wide allow rule
 *   3  passthrough → ask
 *
 * Post-processing at the outer layer: dontAsk converts asks to denies; `auto`
 * mode may resolve asks through the acceptEdits fast-path, the safe-tool
 * allowlist, and finally the classifier; non-interactive contexts deny asks.
 */

import { createDenialTrackingState, recordDenial, recordSuccess, shouldFallbackToPrompting } from "./denialTracking";
import type {
	PermissionAskDecision,
	PermissionCheckContext,
	PermissionDecision,
	PermissionDecisionReason,
	PermissionResult,
	PermissionRule,
	PermissionRuleValue,
} from "./types";

// ============================================================================
// Tool-wide rule matching
// ============================================================================

/**
 * Check if an entire tool matches a rule (no rule content). Also matches MCP
 * server-level rules: rule `mcp__server1` matches tool `mcp__server1_tool1`
 * (omp mints mcp__<server>_<tool> names).
 */
export function toolMatchesRule(toolName: string, rule: PermissionRule): boolean {
	// Rule must not have content to match the entire tool
	if (rule.ruleValue.ruleContent !== undefined) {
		return false;
	}
	if (rule.ruleValue.toolName === toolName) {
		return true;
	}
	// MCP server-level permission: "mcp__server1" matches "mcp__server1_<tool>"
	const ruleTool = rule.ruleValue.toolName;
	if (ruleTool.startsWith("mcp__") && toolName.startsWith("mcp__")) {
		return toolName.startsWith(`${ruleTool}_`) || toolName === ruleTool;
	}
	return false;
}

function findToolWideRule(rules: PermissionRule[], toolName: string): PermissionRule | null {
	return rules.find(rule => toolMatchesRule(toolName, rule)) ?? null;
}

/** Content rules bound to this tool (any behavior), for diagnostics/updates. */
export function contentRulesForTool(rules: PermissionRule[], toolName: string): PermissionRule[] {
	return rules.filter(rule => rule.ruleValue.toolName === toolName && rule.ruleValue.ruleContent !== undefined);
}

export function hasRuleValueForTool(rules: PermissionRule[], toolName: string, content: string): boolean {
	return rules.some(rule => rule.ruleValue.toolName === toolName && rule.ruleValue.ruleContent === content);
}

export function findRuleByValue(
	rules: PermissionRule[],
	behavior: PermissionRule["ruleBehavior"],
	value: PermissionRuleValue,
): PermissionRule | undefined {
	return rules.find(
		rule =>
			rule.ruleBehavior === behavior &&
			rule.ruleValue.toolName === value.toolName &&
			rule.ruleValue.ruleContent === value.ruleContent,
	);
}

// ============================================================================
// Messages
// ============================================================================

function permissionRequestMessage(toolName: string, reason?: PermissionDecisionReason): string {
	if (reason?.type === "rule") {
		return `Permission request for ${toolName}: rule "${ruleToString(reason.rule)}" requires confirmation.`;
	}
	if (reason?.type === "safetyCheck") {
		return `Permission request for ${toolName}: ${reason.reason}`;
	}
	return `Permission requested to use ${toolName}.`;
}

export function ruleToString(rule: PermissionRule): string {
	return rule.ruleValue.ruleContent === undefined
		? rule.ruleValue.toolName
		: `${rule.ruleValue.toolName}(${rule.ruleValue.ruleContent})`;
}

// ============================================================================
// Inner decision flow (1a → 3)
// ============================================================================

async function checkPermissionInner(
	toolName: string,
	input: Record<string, unknown>,
	ctx: PermissionCheckContext,
	toolUseId?: string,
): Promise<PermissionDecision> {
	// 1a. Entire tool is denied
	const denyRule = findToolWideRule(ctx.rules.deny, toolName);
	if (denyRule) {
		return {
			behavior: "deny",
			decisionReason: { type: "rule", rule: denyRule },
			message: `Permission to use ${toolName} has been denied.`,
			...(toolUseId ? { toolUseId } : {}),
		};
	}

	// 1b. Entire tool must always ask — unless this exact call runs inside the
	// OS sandbox the user configured to auto-allow (CC parity: ask rules still
	// apply to commands that won't be sandboxed).
	const askRule = findToolWideRule(ctx.rules.ask, toolName);
	if (askRule && !ctx.canSandboxAutoAllow?.(toolName, input)) {
		return {
			behavior: "ask",
			decisionReason: { type: "rule", rule: askRule },
			message: permissionRequestMessage(toolName, { type: "rule", rule: askRule }),
		};
	}

	// 1c. Ask the tool implementation for a content-dependent permission result
	let toolPermissionResult: PermissionResult = {
		behavior: "passthrough",
		message: permissionRequestMessage(toolName),
	};
	if (ctx.checkTool) {
		try {
			toolPermissionResult = await ctx.checkTool(toolName, input, ctx);
		} catch (error) {
			if (isAbortError(error)) {
				throw error;
			}
			// A crashing tool check must not block unrelated tools — treat it as
			// passthrough (CC logs and continues; decision logic is unchanged).
			toolPermissionResult = {
				behavior: "passthrough",
				message: permissionRequestMessage(toolName),
			};
		}
	}

	// 1d. Tool implementation denied permission
	if (toolPermissionResult.behavior === "deny") {
		return toolPermissionResult;
	}

	// 1e. Tool requires user interaction even in bypass mode
	if (ctx.requiresUserInteraction?.(toolName) && toolPermissionResult.behavior === "ask") {
		return toolPermissionResult;
	}

	// 1f. Content-specific ask rules from the tool's check are bypass-immune:
	// a user-written `bash(rm -rf:*)` ask rule must prompt even under
	// bypassPermissions, exactly like the deny rules caught at 1d.
	if (
		toolPermissionResult.behavior === "ask" &&
		toolPermissionResult.decisionReason?.type === "rule" &&
		toolPermissionResult.decisionReason.rule.ruleBehavior === "ask"
	) {
		return toolPermissionResult;
	}

	// 1g. Safety checks (.git/, .claude/, shell configs, path-bypass attempts) are
	// bypass-immune — they must prompt even in bypassPermissions mode.
	if (toolPermissionResult.behavior === "ask" && toolPermissionResult.decisionReason?.type === "safetyCheck") {
		return toolPermissionResult;
	}

	// 2a. Bypass modes allow everything the earlier bypass-immune steps didn't catch
	const shouldBypassPermissions =
		ctx.mode === "bypassPermissions" || (ctx.mode === "plan" && ctx.isBypassPermissionsModeAvailable);
	if (shouldBypassPermissions) {
		return {
			behavior: "allow",
			updatedInput: updatedInputFrom(toolPermissionResult, input),
			decisionReason: { type: "mode", mode: ctx.mode },
		};
	}

	// 2b. Entire tool is allowed
	const alwaysAllowedRule = findToolWideRule(ctx.rules.allow, toolName);
	if (alwaysAllowedRule) {
		return {
			behavior: "allow",
			updatedInput: updatedInputFrom(toolPermissionResult, input),
			decisionReason: { type: "rule", rule: alwaysAllowedRule },
		};
	}

	// 3. Convert passthrough to ask
	return toolPermissionResult.behavior === "passthrough"
		? {
				behavior: "ask",
				message: permissionRequestMessage(toolName, toolPermissionResult.decisionReason),
				...(toolPermissionResult.updatedInput ? { updatedInput: toolPermissionResult.updatedInput } : {}),
				...(toolPermissionResult.decisionReason ? { decisionReason: toolPermissionResult.decisionReason } : {}),
				...(toolPermissionResult.suggestions ? { suggestions: toolPermissionResult.suggestions } : {}),
				...(toolPermissionResult.blockedPath ? { blockedPath: toolPermissionResult.blockedPath } : {}),
			}
		: toolPermissionResult;
}

function updatedInputFrom(result: PermissionResult, fallback: Record<string, unknown>): Record<string, unknown> {
	return (result.behavior === "allow" || result.behavior === "ask") && result.updatedInput
		? result.updatedInput
		: fallback;
}

function isAbortError(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError";
}

// ============================================================================
// Outer flow: mode post-processing (dontAsk, auto/classifier, headless)
// ============================================================================

/** Decision-reason marker for an ask a headless host converted to a deny. */
export const HEADLESS_PROMPT_UNAVAILABLE_REASON = "Permission prompts are not available in this context";

/**
 * Evaluate a tool call against the permission rules and mode. `deny` and
 * `ask` decisions carry user-presentable messages; `allow` may carry an
 * `updatedInput` the host must execute instead of the original input.
 */
export async function checkPermission(
	toolName: string,
	input: Record<string, unknown>,
	ctx: PermissionCheckContext,
	options?: { toolUseId?: string },
): Promise<PermissionDecision> {
	const result = await checkPermissionInner(toolName, input, ctx, options?.toolUseId);

	// Reset the consecutive-denial streak on any allow in auto mode.
	if (result.behavior === "allow") {
		if (ctx.mode === "auto" && ctx.denial && ctx.denial.state.consecutiveDenials > 0) {
			ctx.denial.persist(recordSuccess(ctx.denial.state));
		}
		return result;
	}

	if (result.behavior !== "ask") {
		return result;
	}

	// dontAsk: every prompt converts to a deny (applied last so early returns
	// in the inner flow cannot smuggle a prompt through).
	if (ctx.mode === "dontAsk") {
		return {
			behavior: "deny",
			decisionReason: { type: "mode", mode: "dontAsk" },
			message: `Permission request for ${toolName} was auto-denied: permission mode is dontAsk.`,
		};
	}

	// auto mode: resolve the ask without prompting when possible.
	if (ctx.mode === "auto" && ctx.classifier) {
		const autoResult = await resolveAskInAutoMode(toolName, input, result, ctx);
		if (autoResult) {
			return autoResult;
		}
	}

	// Non-interactive: an unresolved ask cannot be answered — deny. The
	// sentinel reason lets hosts with their own tier-aware headless policy
	// (reads auto-approve, exec fails closed) recognize the converted ask.
	if (!ctx.isInteractive) {
		return {
			behavior: "deny",
			decisionReason: { type: "other", reason: HEADLESS_PROMPT_UNAVAILABLE_REASON },
			message: `Permission request for ${toolName} was auto-denied: permission prompts are not available in this context.`,
		};
	}

	return result;
}

/**
 * Returns a decision when auto mode resolved the ask, or undefined to fall
 * through to normal prompting (mirrors CC's auto-mode branch).
 */
async function resolveAskInAutoMode(
	toolName: string,
	input: Record<string, unknown>,
	ask: PermissionAskDecision,
	ctx: PermissionCheckContext & { classifier: NonNullable<PermissionCheckContext["classifier"]> },
): Promise<PermissionDecision | undefined> {
	const denialState = ctx.denial?.state ?? createDenialTrackingState();
	const persist = (state: typeof denialState) => ctx.denial?.persist(state);

	// Safety checks that no classifier may wave through stay immune to auto.
	if (ask.decisionReason?.type === "safetyCheck" && !ask.decisionReason.classifierApprovable) {
		if (!ctx.isInteractive) {
			return {
				behavior: "deny",
				message: ask.message,
				decisionReason: {
					type: "other",
					reason: "Safety check requires interactive approval but permission prompts are unavailable here",
				},
			};
		}
		return undefined;
	}

	// Tools demanding interaction are never auto-resolved.
	if (ctx.requiresUserInteraction?.(toolName)) {
		return undefined;
	}

	// AcceptEdits fast-path: if the tool's own check would allow this in
	// acceptEdits mode, approve without paying for a classifier call. Skipped
	// for tools whose allow result hides unclassifiable glue work (task/eval).
	if (ctx.checkTool && !ctx.skipAcceptEditsFastPath?.(toolName)) {
		try {
			const acceptEditsResult = await ctx.checkTool(toolName, input, { ...ctx, mode: "acceptEdits" });
			if (acceptEditsResult.behavior === "allow") {
				persist(recordSuccess(denialState));
				return {
					behavior: "allow",
					updatedInput: acceptEditsResult.updatedInput ?? input,
					decisionReason: { type: "mode", mode: "auto" },
				};
			}
		} catch (error) {
			if (isAbortError(error)) {
				throw error;
			}
			// Fall through to the classifier on a failed fast-path probe.
		}
	}

	// Safe-tool allowlist skips the classifier entirely.
	if (ctx.isOnSafeAllowlist?.(toolName)) {
		persist(recordSuccess(denialState));
		return {
			behavior: "allow",
			updatedInput: input,
			decisionReason: { type: "mode", mode: "auto" },
		};
	}

	// Run the classifier.
	const classifierResult = await ctx.classifier!(toolName, input, ask);

	// Classifier unavailable: fail open to normal prompting. The ask keeps its
	// message so the user can decide; headless flows deny below in checkPermission.
	if (!classifierResult || classifierResult.unavailable) {
		return {
			...ask,
			decisionReason: {
				type: "classifier",
				classifier: "auto-mode",
				reason: classifierResult?.reason ?? "Classifier unavailable",
			},
		};
	}

	if (classifierResult.behavior === "allow") {
		persist(recordSuccess(denialState));
		return {
			behavior: "allow",
			updatedInput: input,
			decisionReason: { type: "classifier", classifier: "auto-mode", reason: classifierResult.reason },
		};
	}

	// Classifier wants a human: fall back to prompting without counting it
	// as a denial — the user, not the classifier, will decide.
	if (classifierResult.behavior === "ask") {
		return {
			...ask,
			decisionReason: { type: "classifier", classifier: "auto-mode", reason: classifierResult.reason },
			message: `${ask.message} (auto-mode classifier: ${classifierResult.reason})`,
		};
	}

	// Classifier denied: track the denial and check the escalation limits.
	const nextState = recordDenial(denialState);
	persist(nextState);

	if (shouldFallbackToPrompting(nextState)) {
		// Denial limit reached: fall back to prompting with the classifier's
		// reason attached so the user can review.
		return {
			...ask,
			decisionReason: { type: "classifier", classifier: "auto-mode", reason: classifierResult.reason },
			message: `${ask.message} (auto-mode classifier: ${classifierResult.reason})`,
		};
	}

	return {
		behavior: "deny",
		decisionReason: { type: "classifier", classifier: "auto-mode", reason: classifierResult.reason },
		message: `Auto-mode classifier blocked this ${toolName} action: ${classifierResult.reason}`,
	};
}
