/**
 * Contract: the settings-backed gate enforces tool-wide rules, maps the
 * legacy approval modes onto the new modes, defers unremarkable calls to the
 * host tier gate (including headless reads, which fail closed there per tier),
 * and persists always-allow choices — the global option into
 * `permissions.allow`, the "in this project" option into
 * `<projectDir>/.claude/settings.local.json` (Claude Code compatible).
 */
import { describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { t } from "@oh-my-pi/pi-i18n";
import { removeSyncWithRetries, TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { evaluateCcPermissions, persistAlwaysAllow, promptCcPermission } from "../../src/security/gate";
import type { ExtensionUIContext, ExtensionUISelectItem } from "../../src/extensibility/extensions/types";
import type { PermissionAskDecision } from "../../src/security/core/types";
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

/** Minimal UI stub: `select` always answers with `pickedLabel`. */
function makeUi(pickedLabel: string): { ui: ExtensionUIContext; presented: string[] } {
	const presented: string[] = [];
	const ui = {
		select: async (_title: string, options: ExtensionUISelectItem[]) => {
			for (const option of options) {
				presented.push(typeof option === "string" ? option : option.label);
			}
			return pickedLabel;
		},
		input: async () => undefined,
		notify: () => {},
	} as unknown as ExtensionUIContext;
	return { ui, presented };
}

const ASK: PermissionAskDecision = { behavior: "ask", message: "Allow web_fetch?" };

describe("promptCcPermission persistence", () => {
	test('the "in this project" option writes .claude/settings.local.json (and not permissions.allow)', async () => {
		await using dir = await TempDir.create("omp-perm-gate-proj-");
		// CC's appendPermissionRule maintains the GLOBAL gitignore only inside
		// a git repo; make the repo real and HOME fake so nothing touches the
		// real ~/.config (spyOn covers os.homedir — bun caches the env HOME —
		// and process.env keeps the spawned `git check-ignore` hermetic).
		execFileSync("git", ["init", "--quiet", dir.path()], { stdio: "ignore" });
		const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-perm-gate-home-"));
		const previousHome = process.env.HOME;
		const previousXdg = process.env.XDG_CONFIG_HOME;
		process.env.HOME = homeDir;
		process.env.XDG_CONFIG_HOME = path.join(homeDir, ".config");
		const homedirSpy = spyOn(os, "homedir").mockReturnValue(homeDir);
		try {
			const settings = Settings.isolated({});
			const projectLabel = `${t("Yes, and always allow in this project")} web_fetch`;
			const { ui, presented } = makeUi(projectLabel);
			const outcome = await promptCcPermission(ui, settings, "web_fetch", ASK, dir.path());
			expect(outcome).toBe("approve-always");
			expect(presented).toContain(projectLabel);
			expect(JSON.parse(fs.readFileSync(path.join(dir.path(), ".claude", "settings.local.json"), "utf8"))).toEqual({
				permissions: { allow: ["web_fetch"] },
			});
			expect(cfgPermissionsAllow.get(settings)).not.toContain("web_fetch");
			expect(fs.readFileSync(path.join(homeDir, ".config", "git", "ignore"), "utf8")).toContain(
				"**/.claude/settings.local.json",
			);
		} finally {
			homedirSpy.mockRestore();
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = previousXdg;
			removeSyncWithRetries(homeDir);
		}
	});

	test('the global "always allow" option still writes permissions.allow (not the project file)', async () => {
		await using dir = await TempDir.create("omp-perm-gate-glob-");
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path() });
		const globalLabel = `${t("Yes, and always allow")} web_fetch`;
		const { ui, presented } = makeUi(globalLabel);
		// Project dir available, yet the global choice must win for itself.
		const outcome = await promptCcPermission(ui, settings, "web_fetch", ASK, dir.path());
		expect(outcome).toBe("approve-always");
		expect(presented).toContain(globalLabel);
		expect(cfgPermissionsAllow.get(settings)).toContain("web_fetch");
		expect(fs.existsSync(path.join(dir.path(), ".claude", "settings.local.json"))).toBe(false);
	});
});
