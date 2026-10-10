/**
 * Contract: the ported Claude Code decision flow preserves its evaluation
 * order (deny > ask > tool-check > bypass-immune steps > bypass > allow >
 * passthrough→ask) and the outer mode post-processing (dontAsk, headless
 * deny, auto-mode classifier with denial tracking).
 */
import { describe, expect, test } from "bun:test";
import { checkPermission } from "../../src/security/core/decision";
import { createDenialTrackingState } from "../../src/security/core/denialTracking";
import type {
	DenialTrackingState,
	ParsedRules,
	PermissionCheckContext,
	PermissionResult,
	PermissionRule,
} from "../../src/security/core/types";

function rule(behavior: PermissionRule["ruleBehavior"], toolName: string, ruleContent?: string): PermissionRule {
	return {
		source: "project",
		ruleBehavior: behavior,
		ruleValue: ruleContent === undefined ? { toolName } : { toolName, ruleContent },
	};
}

function rules(partial: Partial<ParsedRules> = {}): ParsedRules {
	return { allow: [], deny: [], ask: [], ...partial };
}

function ctx(overrides: Partial<PermissionCheckContext> = {}): PermissionCheckContext {
	return {
		mode: "default",
		rules: rules(),
		workingDirectories: new Map(),
		isInteractive: true,
		isBypassPermissionsModeAvailable: false,
		...overrides,
	};
}

const passthrough: PermissionResult = { behavior: "passthrough", message: "passthrough" };

describe("inner flow ordering", () => {
	test("1a: tool-wide deny beats allow rules and bypass mode", async () => {
		const decision = await checkPermission(
			"bash",
			{},
			ctx({
				mode: "bypassPermissions",
				isBypassPermissionsModeAvailable: true,
				rules: rules({ deny: [rule("deny", "bash")], allow: [rule("allow", "bash")] }),
			}),
		);
		expect(decision.behavior).toBe("deny");
		expect(decision.behavior === "deny" && decision.decisionReason.type).toBe("rule");
	});

	test("content rules never match tool-wide lookups", async () => {
		// A bash(rm:*) deny rule is not a tool-wide deny: without a tool check it
		// does not fire; the call falls through to the mode/passthrough path.
		const decision = await checkPermission(
			"bash",
			{ command: "rm -rf /" },
			ctx({ rules: rules({ deny: [rule("deny", "bash", "rm:*")] }) }),
		);
		expect(decision.behavior).toBe("ask");
	});

	test("1b: tool-wide ask rule prompts even in bypass mode", async () => {
		const decision = await checkPermission(
			"task",
			{},
			ctx({ mode: "bypassPermissions", isBypassPermissionsModeAvailable: true, rules: rules({ ask: [rule("ask", "task")] }) }),
		);
		expect(decision.behavior).toBe("ask");
	});

	test("1b: sandbox auto-allow skips the tool-wide ask rule", async () => {
		const decision = await checkPermission(
			"bash",
			{ command: "ls" },
			ctx({
				mode: "bypassPermissions",
				isBypassPermissionsModeAvailable: true,
				rules: rules({ ask: [rule("ask", "bash")] }),
				canSandboxAutoAllow: () => true,
			}),
		);
		expect(decision.behavior).toBe("allow");
	});

	test("1d: tool check deny is enforced under bypass mode", async () => {
		const decision = await checkPermission(
			"write",
			{},
			ctx({
				mode: "bypassPermissions",
				isBypassPermissionsModeAvailable: true,
				checkTool: () => ({ behavior: "deny", message: "nope", decisionReason: { type: "other", reason: "blocked" } }),
			}),
		);
		expect(decision.behavior).toBe("deny");
	});

	test("1e: requiresUserInteraction keeps the ask under bypass", async () => {
		const decision = await checkPermission(
			"plan_confirm",
			{},
			ctx({
				mode: "bypassPermissions",
				isBypassPermissionsModeAvailable: true,
				checkTool: () => ({ behavior: "ask", message: "confirm" }),
				requiresUserInteraction: name => name === "plan_confirm",
			}),
		);
		expect(decision.behavior).toBe("ask");
	});

	test("1f: content ask rule from the tool check is bypass-immune", async () => {
		const askRule = rule("ask", "bash", "rm -rf:*");
		const decision = await checkPermission(
			"bash",
			{ command: "rm -rf /" },
			ctx({
				mode: "bypassPermissions",
				isBypassPermissionsModeAvailable: true,
				checkTool: () => ({ behavior: "ask", message: "asked", decisionReason: { type: "rule", rule: askRule } }),
			}),
		);
		expect(decision.behavior).toBe("ask");
		expect(decision.behavior === "ask" && decision.decisionReason?.type).toBe("rule");
	});

	test("1g: safetyCheck ask is bypass-immune", async () => {
		const decision = await checkPermission(
			"edit",
			{},
			ctx({
				mode: "bypassPermissions",
				isBypassPermissionsModeAvailable: true,
				checkTool: () => ({
					behavior: "ask",
					message: "protect",
					decisionReason: { type: "safetyCheck", reason: "touches .git", classifierApprovable: false },
				}),
			}),
		);
		expect(decision.behavior).toBe("ask");
	});

	test("2a: bypass mode allows a passthrough call", async () => {
		const decision = await checkPermission(
			"bash",
			{},
			ctx({ mode: "bypassPermissions", isBypassPermissionsModeAvailable: true, checkTool: () => passthrough }),
		);
		expect(decision.behavior).toBe("allow");
		expect(decision.behavior === "allow" && decision.decisionReason).toEqual({ type: "mode", mode: "bypassPermissions" });
	});

	test("2a: plan mode allows only when bypass is available", async () => {
		const withBypass = await checkPermission("bash", {}, ctx({ mode: "plan", isBypassPermissionsModeAvailable: true }));
		expect(withBypass.behavior).toBe("allow");
		const withoutBypass = await checkPermission("bash", {}, ctx({ mode: "plan", isBypassPermissionsModeAvailable: false }));
		expect(withoutBypass.behavior).toBe("ask");
	});

	test("2b: tool-wide allow rule allows a passthrough call", async () => {
		const allowRule = rule("allow", "web_fetch");
		const decision = await checkPermission("web_fetch", {}, ctx({ rules: rules({ allow: [allowRule] }) }));
		expect(decision.behavior).toBe("allow");
	});

	test("3: passthrough becomes an ask in default mode", async () => {
		const decision = await checkPermission("bash", {}, ctx());
		expect(decision.behavior).toBe("ask");
		expect(decision.behavior === "ask" && decision.decisionReason).toBeUndefined();
	});

	test("allow carries updatedInput from the tool check", async () => {
		const decision = await checkPermission(
			"bash",
			{ command: "ls" },
			ctx({
				rules: rules({ allow: [rule("allow", "bash")] }),
				checkTool: () => ({ behavior: "allow", updatedInput: { command: "ls --color" } }),
			}),
		);
		expect(decision.behavior === "allow" && decision.updatedInput).toEqual({ command: "ls --color" });
	});

	test("MCP server-level rules match concrete server tools", async () => {
		const decision = await checkPermission("mcp__srv1_tool", {}, ctx({ rules: rules({ deny: [rule("deny", "mcp__srv1")] }) }));
		expect(decision.behavior).toBe("deny");
		const other = await checkPermission("mcp__srv2_tool", {}, ctx({ rules: rules({ deny: [rule("deny", "mcp__srv1")] }) }));
		expect(other.behavior).toBe("ask");
	});

	test("a crashing tool check falls through as passthrough", async () => {
		const decision = await checkPermission(
			"bash",
			{},
			ctx({
				checkTool: () => {
					throw new Error("boom");
				},
			}),
		);
		expect(decision.behavior).toBe("ask");
	});

	test("abort errors from the tool check propagate", async () => {
		const abort = new Error("aborted");
		abort.name = "AbortError";
		expect(
			checkPermission(
				"bash",
				{},
				ctx({
					checkTool: () => {
						throw abort;
					},
				}),
			),
		).rejects.toThrow("aborted");
	});
});

describe("outer mode post-processing", () => {
	test("dontAsk converts every ask into a deny", async () => {
		const decision = await checkPermission("bash", {}, ctx({ mode: "dontAsk" }));
		expect(decision.behavior).toBe("deny");
		expect(decision.behavior === "deny" && decision.decisionReason).toEqual({ type: "mode", mode: "dontAsk" });
	});

	test("headless hosts deny unresolved asks", async () => {
		const decision = await checkPermission("bash", {}, ctx({ isInteractive: false }));
		expect(decision.behavior).toBe("deny");
	});

	test("headless deny still enforces explicit deny rules with their reason", async () => {
		const decision = await checkPermission("bash", {}, ctx({ isInteractive: false, rules: rules({ deny: [rule("deny", "bash")] }) }));
		expect(decision.behavior).toBe("deny");
		expect(decision.behavior === "deny" && decision.decisionReason.type).toBe("rule");
	});
});

describe("auto mode", () => {
	function autoCtx(overrides: Partial<PermissionCheckContext> = {}) {
		const persisted: DenialTrackingState[] = [];
		const base = ctx({
			mode: "auto",
			denial: { state: createDenialTrackingState(), persist: state => void persisted.push(structuredClone(state)) },
			...overrides,
		});
		return { base, persisted };
	}

	test("acceptEdits fast-path allows without consulting the classifier", async () => {
		let classifierCalled = false;
		const { base } = autoCtx({
			checkTool: (_t, _i, c) =>
				c.mode === "acceptEdits" ? { behavior: "allow", updatedInput: { command: "ls" } } : passthrough,
			classifier: async () => {
				classifierCalled = true;
				return { behavior: "allow", reason: "x", confidence: "high" };
			},
		});
		const decision = await checkPermission("edit", { path: "a.ts" }, base);
		expect(decision.behavior).toBe("allow");
		expect(classifierCalled).toBe(false);
	});

	test("safe-tool allowlist skips the classifier", async () => {
		let classifierCalled = false;
		const { base } = autoCtx({
			isOnSafeAllowlist: name => name === "read",
			classifier: async () => {
				classifierCalled = true;
				return { behavior: "allow", reason: "x", confidence: "high" };
			},
		});
		const decision = await checkPermission("read", {}, base);
		expect(decision.behavior).toBe("allow");
		expect(classifierCalled).toBe(false);
	});

	test("classifier allow is reported as a classifier decision", async () => {
		const { base, persisted } = autoCtx({
			classifier: async () => ({ behavior: "allow", reason: "benign", confidence: "high" }),
		});
		const decision = await checkPermission("bash", {}, base);
		expect(decision.behavior).toBe("allow");
		expect(decision.behavior === "allow" && decision.decisionReason).toEqual({
			type: "classifier",
			classifier: "auto-mode",
			reason: "benign",
		});
		expect(persisted[0]?.consecutiveDenials).toBe(0);
	});

	test("classifier deny records a denial and denies", async () => {
		const { base, persisted } = autoCtx({
			classifier: async () => ({ behavior: "deny", reason: "dangerous", confidence: "high" }),
		});
		const decision = await checkPermission("bash", {}, base);
		expect(decision.behavior).toBe("deny");
		expect(persisted.at(-1)).toEqual({ consecutiveDenials: 1, totalDenials: 1 });
	});

	test("classifier denial at the consecutive limit falls back to prompting", async () => {
		const { base } = autoCtx({
			denial: {
				state: { consecutiveDenials: 2, totalDenials: 2 },
				persist: () => {},
			},
			classifier: async () => ({ behavior: "deny", reason: "dangerous", confidence: "high" }),
		});
		const decision = await checkPermission("bash", {}, base);
		expect(decision.behavior).toBe("ask");
		expect(decision.behavior === "ask" && decision.message).toContain("auto-mode classifier");
	});

	test("classifier 'ask' prompts without counting a denial", async () => {
		const persisted: DenialTrackingState[] = [];
		const { base } = autoCtx({
			denial: { state: createDenialTrackingState(), persist: state => void persisted.push(state) },
			classifier: async () => ({ behavior: "ask", reason: "unsure", confidence: "low" }),
		});
		const decision = await checkPermission("bash", {}, base);
		expect(decision.behavior).toBe("ask");
		expect(persisted).toHaveLength(0);
	});

	test("classifier unavailability fails open to prompting", async () => {
		const { base } = autoCtx({ classifier: async () => undefined });
		const decision = await checkPermission("bash", {}, base);
		expect(decision.behavior).toBe("ask");
		expect(decision.behavior === "ask" && decision.decisionReason?.type).toBe("classifier");
	});

	test("non-approvable safety checks are never handed to the classifier", async () => {
		let classifierCalled = false;
		const { base } = autoCtx({
			checkTool: () => ({
				behavior: "ask",
				message: "protected",
				decisionReason: { type: "safetyCheck", reason: "path bypass attempt", classifierApprovable: false },
			}),
			classifier: async () => {
				classifierCalled = true;
				return { behavior: "allow", reason: "x", confidence: "high" };
			},
		});
		const decision = await checkPermission("edit", {}, base);
		expect(decision.behavior).toBe("ask");
		expect(classifierCalled).toBe(false);
	});

	test("interactive-only tools are not auto-resolved", async () => {
		let classifierCalled = false;
		const { base } = autoCtx({
			requiresUserInteraction: () => true,
			classifier: async () => {
				classifierCalled = true;
				return { behavior: "allow", reason: "x", confidence: "high" };
			},
		});
		const decision = await checkPermission("confirm", {}, base);
		expect(decision.behavior).toBe("ask");
		expect(classifierCalled).toBe(false);
	});

	test("any allow resets the consecutive-denial streak", async () => {
		const persisted: DenialTrackingState[] = [];
		const { base } = autoCtx({
			denial: {
				state: { consecutiveDenials: 2, totalDenials: 5 },
				persist: state => void persisted.push(structuredClone(state)),
			},
			classifier: async () => ({ behavior: "allow", reason: "fine", confidence: "high" }),
		});
		const decision = await checkPermission("bash", {}, base);
		expect(decision.behavior).toBe("allow");
		expect(persisted.at(-1)).toEqual({ consecutiveDenials: 0, totalDenials: 5 });
	});
});
