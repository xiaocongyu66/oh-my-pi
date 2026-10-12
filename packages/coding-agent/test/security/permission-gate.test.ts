/**
 * Contract: the settings-backed gate enforces tool-wide rules, maps the
 * legacy approval modes onto the new modes, defers unremarkable calls to the
 * host tier gate (including headless reads, which fail closed there per tier),
 * and persists always-allow choices into `permissions.allow`.
 */
import { describe, expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { evaluateCcPermissions, persistAlwaysAllow } from "../../src/security/gate";
import { cfgPermissionsAllow, resolvePermissionMode } from "../../src/security/settings";

function evaluate(settings: Settings, toolName: string, isInteractive = true, input: Record<string, unknown> = {}) {
	return evaluateCcPermissions({ toolName, input, settings, isInteractive });
}

describe("evaluateCcPermissions rules", () => {
	test("tool-wide deny rule denies", async () => {
		const settings = Settings.isolated({ "permissions.deny": ["Bash"] });
		const decision = await evaluate(settings, "bash");
		expect(decision?.behavior).toBe("deny");
		expect(decision?.behavior === "deny" && decision.decisionReason.type).toBe("rule");
	});

	test("tool-wide allow rule allows with the rule reason", async () => {
		const settings = Settings.isolated({ "permissions.allow": ["WebFetch"] });
		const decision = await evaluate(settings, "web_fetch");
		expect(decision?.behavior).toBe("allow");
		expect(decision?.behavior === "allow" && decision.decisionReason?.type).toBe("rule");
	});

	test("tool-wide ask rule asks even though the tier gate would allow", async () => {
		const settings = Settings.isolated({ "permissions.ask": ["task"], "tools.approvalMode": "yolo" });
		const decision = await evaluate(settings, "task");
		// yolo maps to bypassPermissions; the ask rule is evaluated first and
		// keeps its content-level basis, so the gate prompts.
		expect(decision?.behavior).toBe("ask");
	});

	test("unremarkable calls defer to the host tier gate", async () => {
		const settings = Settings.isolated({});
		expect(await evaluate(settings, "bash")).toBeUndefined();
	});

	test("headless unremarkable calls also defer (tier gate fails closed per tier)", async () => {
		const settings = Settings.isolated({});
		expect(await evaluate(settings, "read", false)).toBeUndefined();
		expect(await evaluate(settings, "bash", false)).toBeUndefined();
	});

	test("headless deny rules stay enforced", async () => {
		const settings = Settings.isolated({ "permissions.deny": ["bash"] });
		const decision = await evaluate(settings, "bash", false);
		expect(decision?.behavior).toBe("deny");
	});

	test("dontAsk converts unresolved asks into denials", async () => {
		const settings = Settings.isolated({ "permissions.defaultMode": "dontAsk" });
		const decision = await evaluate(settings, "bash");
		expect(decision?.behavior).toBe("deny");
		expect(decision?.behavior === "deny" && decision.decisionReason).toEqual({ type: "mode", mode: "dontAsk" });
	});
});

describe("legacy mode mapping", () => {
	test("yolo maps to bypass and allows everything unremarkable", async () => {
		const settings = Settings.isolated({ "tools.approvalMode": "yolo" });
		const decision = await evaluate(settings, "bash");
		expect(decision?.behavior).toBe("allow");
		expect(decision?.behavior === "allow" && decision.decisionReason).toEqual({
			type: "mode",
			mode: "bypassPermissions",
		});
	});

	test("yolo downgrades when bypass is disabled by policy", async () => {
		const settings = Settings.isolated({
			"tools.approvalMode": "yolo",
			"permissions.disableBypassPermissionsMode": true,
		});
		expect(resolvePermissionMode(settings)).toBe("default");
		expect(await evaluate(settings, "bash")).toBeUndefined();
	});

	test("explicit permissions.defaultMode overrides the legacy mode", async () => {
		const settings = Settings.isolated({ "tools.approvalMode": "yolo", "permissions.defaultMode": "dontAsk" });
		const decision = await evaluate(settings, "bash");
		expect(decision?.behavior).toBe("deny");
	});

	test("write maps to acceptEdits; unremarkable calls defer", async () => {
		const settings = Settings.isolated({ "tools.approvalMode": "write" });
		expect(resolvePermissionMode(settings)).toBe("acceptEdits");
		expect(await evaluate(settings, "bash")).toBeUndefined();
	});

	test("invalid mode strings and unavailable modes fall back", () => {
		const invalid = Settings.isolated({ "permissions.defaultMode": "banana", "tools.approvalMode": "write" });
		expect(resolvePermissionMode(invalid)).toBe("acceptEdits");
		const autoNoClassifier = Settings.isolated({
			"permissions.defaultMode": "auto",
			"permissions.classifier": false,
		});
		expect(resolvePermissionMode(autoNoClassifier)).toBe("default");
		const bypassDisabled = Settings.isolated({
			"permissions.defaultMode": "bypassPermissions",
			"permissions.disableBypassPermissionsMode": true,
		});
		expect(resolvePermissionMode(bypassDisabled)).toBe("default");
	});
});

describe("plan mode bypass carry-over", () => {
	test("plan from an ask-first origin never auto-approves a passthrough call", async () => {
		const settings = Settings.isolated({ "permissions.defaultMode": "plan", "tools.approvalMode": "always-ask" });
		const decision = await evaluate(settings, "web_fetch");
		// No bypass carry-over: the unremarkable ask defers to the tier gate;
		// it must never resolve to an allow.
		expect(decision?.behavior ?? "deferred").not.toBe("allow");
	});

	test("plan from a yolo origin keeps the bypass carry-over", async () => {
		const settings = Settings.isolated({ "permissions.defaultMode": "plan", "tools.approvalMode": "yolo" });
		const decision = await evaluate(settings, "web_fetch");
		expect(decision?.behavior).toBe("allow");
		expect(decision?.behavior === "allow" && decision.decisionReason).toEqual({ type: "mode", mode: "plan" });
	});
});

describe("always-allow persistence", () => {
	test("persistAlwaysAllow appends the tool to permissions.allow", async () => {
		await using dir = await TempDir.create("omp-perm-gate-");
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path() });
		persistAlwaysAllow(settings, "web_fetch");
		expect(cfgPermissionsAllow.get(settings)).toContain("web_fetch");
		persistAlwaysAllow(settings, "web_fetch");
		expect(cfgPermissionsAllow.get(settings)).toEqual(["web_fetch"]);
	});
});
