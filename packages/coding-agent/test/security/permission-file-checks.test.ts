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
		const result = checkFileToolPermission("read", { path: path.join(extra, "x.txt") }, ctx({}, [dir, extra]));
		expect(result.behavior).toBe("allow");
	});

	test("URL inputs skip path rules", () => {
		const result = checkFileToolPermission("read", { path: "https://example.com/page" }, ctx());
		expect(result.behavior).toBe("passthrough");
	});
});

describe("memory carve-out (CC isAutoMemPath parity)", () => {
	function memoryDirs(dir: string) {
		const memoryDir = path.join(dir, ".claude", "projects", "-repo", "memory");
		const localDir = path.join(dir, ".claude", "memory");
		return { memoryDir, localDir, memoryDirectories: { write: [memoryDir], read: [memoryDir, localDir] } };
	}

	test("memory-dir write under .claude allows pre-safety-gate in default mode", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "omp-memcheck-"));
		const { memoryDir, memoryDirectories } = memoryDirs(dir);
		const baseline = checkFileToolPermission("write", { path: path.join(memoryDir, "a.md") }, ctx({}, [dir]));
		expect(baseline.behavior).toBe("ask");
		expect("decisionReason" in result(baseline) && result(baseline).decisionReason?.type).toBe("safetyCheck");

		const exempt = checkFileToolPermission(
			"write",
			{ path: path.join(memoryDir, "a.md") },
			ctx({ memoryDirectories }, [dir]),
		);
		expect(exempt.behavior).toBe("allow");
		expect(result(exempt).decisionReason?.reason).toContain("auto memory");
	});

	function result(r: ReturnType<typeof checkFileToolPermission>) {
		return r as { decisionReason?: { type: string; reason?: string } };
	}

	test("deny rules still block memory writes", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "omp-memcheck-"));
		const { memoryDir, memoryDirectories } = memoryDirs(dir);
		const rules = parsedRulesFromEffective(undefined, [`Write(//${dir.slice(1)}/.claude/projects/**)`]);
		const exempt = checkFileToolPermission(
			"write",
			{ path: path.join(memoryDir, "a.md") },
			ctx({ rules, memoryDirectories }, [dir]),
		);
		expect(exempt.behavior).toBe("deny");
	});

	test("read-only memory sources are readable; read ask rules still bind", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "omp-memcheck-"));
		const { localDir, memoryDirectories } = memoryDirs(dir);
		const read = checkFileToolPermission(
			"read",
			{ path: path.join(localDir, "b.md") },
			ctx({ memoryDirectories }, [dir]),
		);
		expect(read.behavior).toBe("allow");

		const rules = parsedRulesFromEffective(undefined, undefined, [`Read(//${dir.slice(1)}/.claude/memory/**)`]);
		const asked = checkFileToolPermission(
			"read",
			{ path: path.join(localDir, "b.md") },
			ctx({ rules, memoryDirectories }, [dir]),
		);
		expect(asked.behavior).toBe("ask");
	});

	test("outside paths get no exemption", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "omp-memcheck-"));
		const { memoryDirectories } = memoryDirs(dir);
		const sibling = path.join(dir, ".claude", "settings.json");
		const outside = checkFileToolPermission("read", { path: sibling }, ctx({ memoryDirectories }, [dir]));
		// in-workspace read → allow via working dir, NOT via the memory reason
		expect(result(outside).decisionReason?.reason ?? "").not.toContain("auto memory");
		const writeOutside = checkFileToolPermission("write", { path: sibling }, ctx({ memoryDirectories }, [dir]));
		expect(writeOutside.behavior).toBe("ask");
	});
});
