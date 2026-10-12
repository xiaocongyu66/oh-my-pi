/**
 * Contract: the CC path-validation engine (`bash-path-validation.ts`) wired
 * into bash-check validates the path arguments of the ~35 filesystem
 * commands: writes outside the working directories ask in ask-preserving
 * modes (and are skipped under bypassPermissions), read-only commands pass
 * through, the dangerous-removal and sensitive-file gates stay bypass-immune,
 * and process substitution promotes to a prompt.
 */
import { describe, expect, test } from "bun:test";
import { Settings } from "../../src/config/settings";
import { bashToolCheckPermission } from "../../src/security/bash-check";
import { evaluateCcPermissions } from "../../src/security/gate";
import { EMPTY_RULES } from "../../src/security/core/rulesLoader";
import type { PermissionCheckContext } from "../../src/security/core/types";

// Pin the process-wide settings singleton so flag reads (read-only
// auto-allow) behave identically whether this file runs alone or in a
// combined suite where another file initialized settings first.
// Idempotent: returns the existing singleton when another test module
// initialized it first.
await Settings.init({});

function ctx(mode: PermissionCheckContext["mode"]): PermissionCheckContext {
	return {
		mode,
		rules: EMPTY_RULES,
		workingDirectories: new Map(),
		isInteractive: true,
		isBypassPermissionsModeAvailable: false,
	};
}

function behavior(command: string, mode: PermissionCheckContext["mode"] = "default"): string {
	return bashToolCheckPermission("bash", { command }, ctx(mode)).behavior;
}

describe("bash path-command writes ask in default mode", () => {
	test("mkdir/touch/mv/cp targeting paths outside the working directory ask", () => {
		expect(behavior("mkdir /tmp/omp-bpv-mkdir")).toBe("ask");
		expect(behavior("touch /tmp/omp-bpv-touch.txt")).toBe("ask");
		expect(behavior("mv a /etc/passwd")).toBe("ask");
		expect(behavior("cp a /etc/passwd")).toBe("ask");
	});

	test("in-cwd writes still prompt without acceptEdits (CC parity)", () => {
		expect(behavior("touch omp-bpv-new.txt")).toBe("ask");
		expect(behavior("mkdir omp-bpv-dir")).toBe("ask");
	});

	test("acceptEdits auto-allows in-cwd filesystem commands (CC modeValidation)", () => {
		expect(behavior("touch omp-bpv-new.txt", "acceptEdits")).toBe("allow");
		expect(behavior("mkdir omp-bpv-dir", "acceptEdits")).toBe("allow");
	});

	test("acceptEdits still asks on out-of-cwd and dangerous targets", () => {
		expect(behavior("touch /etc/omp-bpv-outside", "acceptEdits")).toBe("ask");
		expect(behavior("rm -rf /usr", "acceptEdits")).toBe("ask");
	});

	test("cp/mv flags that can bypass path extraction ask (CC COMMAND_VALIDATOR)", () => {
		expect(behavior("cp -r src /tmp/omp-bpv")).toBe("ask");
		expect(behavior("mv -f a b")).toBe("ask");
	});

	test("writes surface through the host gate as asks", async () => {
		const settings = Settings.isolated({});
		const decision = await evaluateCcPermissions({
			toolName: "bash",
			input: { command: "mkdir /tmp/omp-bpv-gate" },
			settings,
			isInteractive: true,
		});
		expect(decision?.behavior).toBe("ask");
	});
});

describe("read-only path commands pass through", () => {
	test("in-cwd reads are auto-allowed (CC step 7, read-only default on)", () => {
		for (const command of [
			"ls",
			"cat README.md",
			"grep -r foo .",
			"find . -name x",
			"wc -l README.md",
			"git status",
		]) {
			expect(behavior(command)).toBe("allow");
		}
	});

	test("line-printing sed reads its file arguments (CC sed allowlist)", () => {
		expect(behavior("sed -n 2p README.md")).toBe("allow");
		expect(behavior("sed -nE 1,3p README.md")).toBe("allow");
		expect(behavior("sed -n s/a/b/p README.md")).toBe("ask");
	});

	test("reads outside the working directory still ask", () => {
		expect(behavior("cat /etc/passwd")).toBe("ask");
		expect(behavior("ls /etc")).toBe("ask");
	});
});

describe("bypassPermissions skips working-dir asks but not bypass-immune gates", () => {
	test("out-of-working-dir command writes and redirects are skipped", () => {
		expect(behavior("mkdir /tmp/omp-bpv-mkdir", "bypassPermissions")).toBe("passthrough");
		expect(behavior("touch /tmp/omp-bpv-touch.txt", "bypassPermissions")).toBe("passthrough");
		expect(behavior("echo x > /tmp/omp-bpv-redirect", "bypassPermissions")).toBe("passthrough");
		expect(behavior("cd /tmp && touch f", "bypassPermissions")).toBe("passthrough");
	});

	test("dangerous removal targets keep asking under bypass", () => {
		expect(behavior("rm -rf /", "bypassPermissions")).toBe("ask");
		expect(behavior("rm -rf ~", "bypassPermissions")).toBe("ask");
		expect(behavior("rmdir /usr", "bypassPermissions")).toBe("ask");
		expect(behavior("timeout 10 rm -rf /", "bypassPermissions")).toBe("ask");
	});

	test("sensitive-file writes keep asking under bypass (safetyCheck is bypass-immune)", () => {
		expect(behavior("touch .git/config", "bypassPermissions")).toBe("ask");
		// redirect form must behave identically to cp/touch on the same path
		expect(behavior("echo x > .git/config", "bypassPermissions")).toBe("ask");
		expect(behavior("echo x > ~/.omp/settings.json", "bypassPermissions")).toBe("ask");
		expect(behavior("echo hi 2> ~/.omp/agent/probe.yml", "bypassPermissions")).toBe("ask");
		// both orders of a compound with one protected write
		expect(behavior("echo a > /tmp/omp-bpv-ok && echo x > ~/.omp/settings.json", "bypassPermissions")).toBe("ask");
		expect(behavior("echo x > ~/.omp/settings.json && echo a > /tmp/omp-bpv-ok", "bypassPermissions")).toBe("ask");
		// stderr fd redirects are writes too; 2>&1 is not a file write
		expect(behavior("echo x >&2", "bypassPermissions")).toBe("passthrough");
	});
});

describe("process substitution and cd+write compounds ask", () => {
	test("process substitution promotes to a prompt", () => {
		expect(behavior("echo x > >(tee /tmp/omp-bpv)")).toBe("ask");
		expect(behavior("diff <(ls) <(ls)")).toBe("ask");
	});

	test("quoted process substitution is caught by the CC raw-text gate", () => {
		expect(behavior("grep -e '<(' README.md")).toBe("ask");
	});

	test("cd + write and cd + redirect compounds ask (CC cd gates)", () => {
		expect(behavior("cd /tmp && touch f")).toBe("ask");
		expect(behavior("cd /tmp && echo x > /tmp/f")).toBe("ask");
		expect(behavior("cd /tmp && echo x > /dev/null")).toBe("ask");
		// CC type-'other' compound asks are skipped under bypassPermissions.
		expect(behavior("cd /tmp && echo x > /tmp/f", "bypassPermissions")).toBe("passthrough");
	});

	test("redirect targets keep their existing validation", () => {
		expect(behavior("echo x > /tmp/omp-bpv-redirect")).toBe("ask");
		expect(behavior("echo x >> omp-bpv-rel.txt")).toBe("ask");
		expect(behavior("echo x > /dev/null")).toBe("passthrough");
	});
});
