/**
 * Contract: file-tool checks follow the ported ordering — sensitive paths
 * (.git/, .bashrc, …) ask as bypass-immune safety checks even under allow
 * rules; deny/ask/allow content rules bind; workspace writes flow through
 * acceptEdits; everything else defers (ask without a reason).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkFileToolPermission } from "../../src/security/file-checks";
import { EMPTY_RULES, parsedRulesFromEffective } from "../../src/security/core/rulesLoader";
import type { PermissionCheckContext } from "../../src/security/core/types";

function ctx(overrides: Partial<PermissionCheckContext> = {}, dirs: readonly string[] = []): PermissionCheckContext {
	const workingDirectories = new Map<string, { path: string; source: "project" }>();
	for (const dir of dirs) workingDirectories.set(dir, { path: dir, source: "project" });
	return {
		mode: "default",
		rules: EMPTY_RULES,
		workingDirectories,
		isInteractive: true,
		isBypassPermissionsModeAvailable: false,
		...overrides,
	};
}

describe("file tool checks", () => {
	test("workspace write in default mode is an unremarkable ask", async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "omp-filecheck-"));
		const result = checkFileToolPermission("edit", { path: path.join(dir, "a.ts") }, ctx({}, [dir]));
		expect(result.behavior).toBe("ask");
		expect((result as { decisionReason?: unknown }).decisionReason).toBeUndefined();
	});

	test("acceptEdits allows workspace writes", async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "omp-filecheck-"));
		const result = checkFileToolPermission(
			"edit",
			{ path: path.join(dir, "a.ts") },
			ctx({ mode: "acceptEdits" }, [dir]),
		);
		expect(result.behavior).toBe("allow");
	});

	test("editing .git/config always asks with a bypass-immune safety check", async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "omp-filecheck-"));
		const rules = parsedRulesFromEffective([`Edit(//${dir.slice(1)}/**)`]);
		const result = checkFileToolPermission(
			"edit",
			{ path: path.join(dir, ".git", "config") },
			ctx({ mode: "acceptEdits", rules }, [dir]),
		);
		expect(result.behavior).toBe("ask");
		expect("decisionReason" in result && result.decisionReason?.type).toBe("safetyCheck");
	});

	test("deny rule blocks a write outright", async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "omp-filecheck-"));
		const rules = parsedRulesFromEffective(undefined, [`Write(//${dir.slice(1)}/forbidden.txt)`]);
		const result = checkFileToolPermission(
			"write",
			{ path: path.join(dir, "forbidden.txt") },
			ctx({ mode: "acceptEdits", rules }, [dir]),
		);
		expect(result.behavior).toBe("deny");
	});

	test("read of a dotfile can be denied by rule", async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "omp-filecheck-"));
		const env = path.join(dir, ".env");
		const rules = parsedRulesFromEffective(undefined, [`Read(//${dir.slice(1)}/.env)`]);
		const result = checkFileToolPermission("read", { path: env }, ctx({ rules }, [dir]));
		expect(result.behavior).toBe("deny");
	});

	test("reads outside the workspace ask with workingDir reason", async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "omp-filecheck-"));
		const other = mkdtempSync(path.join(os.tmpdir(), "omp-other-"));
		const result = checkFileToolPermission("read", { path: path.join(other, "x.txt") }, ctx({}, [dir]));
		expect(result.behavior).toBe("ask");
		expect("decisionReason" in result && result.decisionReason?.type).toBe("workingDir");
	});

	test("additional directories extend readable scope", async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "omp-filecheck-"));
		const extra = mkdtempSync(path.join(os.tmpdir(), "omp-extra-"));
		const result = checkFileToolPermission(
			"read",
			{ path: path.join(extra, "x.txt") },
			ctx({}, [dir, extra]),
		);
		expect(result.behavior).toBe("allow");
	});

	test("URL inputs skip path rules", () => {
		const result = checkFileToolPermission("read", { path: "https://example.com/page" }, ctx());
		expect(result.behavior).toBe("passthrough");
	});
});
