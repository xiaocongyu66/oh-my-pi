/**
 * Contract: CC's sensitive-file write gating. Writes to protected paths —
 * .git/config, shell profiles, .claude/settings.json, the agent's own config
 * layers, and anything reached through a symlink chain — ask with a
 * bypass-immune safetyCheck even in acceptEdits mode, while normal workspace
 * writes flow through. Every path a payload writes is gated: compound edit
 * renames, apply_patch/sloppy/hashline payload targets (including Move/MV
 * destinations), and ast_edit `paths`.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkFileToolPermission } from "../../src/security/file-checks";
import { isAgentConfigFilePath } from "../../src/security/core/pathSafety";
import { EMPTY_RULES } from "../../src/security/core/rulesLoader";
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

function acceptEdits(dirs: readonly string[], overrides: Partial<PermissionCheckContext> = {}): PermissionCheckContext {
	return ctx({ mode: "acceptEdits", ...overrides }, dirs);
}

function workspace(): string {
	return mkdtempSync(path.join(os.tmpdir(), "omp-sensitive-"));
}

function safetyReason(result: ReturnType<typeof checkFileToolPermission>): unknown {
	return "decisionReason" in result ? result.decisionReason?.type : undefined;
}

describe("sensitive write gates (CC checkPathSafetyForAutoEdit parity)", () => {
	test("write to .git/config asks in acceptEdits", () => {
		const dir = workspace();
		const result = checkFileToolPermission("write", { path: path.join(dir, ".git", "config") }, acceptEdits([dir]));
		expect(result.behavior).toBe("ask");
		expect(safetyReason(result)).toBe("safetyCheck");
	});

	test("write to ~/.bashrc asks in acceptEdits", () => {
		const dir = workspace();
		const result = checkFileToolPermission("write", { path: path.join(os.homedir(), ".bashrc") }, acceptEdits([dir]));
		expect(result.behavior).toBe("ask");
		expect(safetyReason(result)).toBe("safetyCheck");
	});

	test("edit of .claude/settings.json asks in acceptEdits", () => {
		const dir = workspace();
		const result = checkFileToolPermission(
			"edit",
			{ path: path.join(dir, ".claude", "settings.json") },
			acceptEdits([dir]),
		);
		expect(result.behavior).toBe("ask");
		expect(safetyReason(result)).toBe("safetyCheck");
	});

	test("write to a normal source file allows in acceptEdits", () => {
		const dir = workspace();
		const result = checkFileToolPermission("write", { path: path.join(dir, "src", "app.ts") }, acceptEdits([dir]));
		expect(result.behavior).toBe("allow");
	});

	test("symlink escaping into a sensitive directory asks in acceptEdits", () => {
		const dir = workspace();
		mkdirSync(path.join(dir, ".git"));
		writeFileSync(path.join(dir, ".git", "config"), "[core]\n");
		symlinkSync(path.join(dir, ".git", "config"), path.join(dir, "innocent.txt"));
		const result = checkFileToolPermission("write", { path: path.join(dir, "innocent.txt") }, acceptEdits([dir]));
		expect(result.behavior).toBe("ask");
		expect(safetyReason(result)).toBe("safetyCheck");
	});
});

describe("payload-embedded write targets", () => {
	test("apply_patch payload touching .git/config asks in acceptEdits", () => {
		const dir = workspace();
		const input = `*** Begin Patch\n*** Update File: ${path.join(dir, ".git", "config")}\n@@\n-a\n+b\n*** End Patch`;
		const result = checkFileToolPermission("edit", { input }, acceptEdits([dir]));
		expect(result.behavior).toBe("ask");
		expect(safetyReason(result)).toBe("safetyCheck");
	});

	test("apply_patch Move to a shell profile asks in acceptEdits", () => {
		const dir = workspace();
		const input = `*** Begin Patch\n*** Update File: ${path.join(dir, "app.ts")}\n*** Move to: ${path.join(os.homedir(), ".bashrc")}\n@@\n-a\n+b\n*** End Patch`;
		const result = checkFileToolPermission("edit", { input }, acceptEdits([dir]));
		expect(result.behavior).toBe("ask");
		expect(safetyReason(result)).toBe("safetyCheck");
	});

	test("patch-mode rename into .git asks in acceptEdits", () => {
		const dir = workspace();
		const result = checkFileToolPermission(
			"edit",
			{
				path: path.join(dir, "a.py"),
				edits: [{ op: "update", rename: path.join(dir, ".git", "config"), diff: "@@\n-a\n+b\n" }],
			},
			acceptEdits([dir]),
		);
		expect(result.behavior).toBe("ask");
		expect(safetyReason(result)).toBe("safetyCheck");
	});

	test("hashline MV into a sensitive path asks in acceptEdits", () => {
		const dir = workspace();
		const input = `[${path.join(dir, "a.ts")}#abcd]\nPUT 3.=3:\n+text\nMV ${path.join(os.homedir(), ".zshrc")}`;
		const result = checkFileToolPermission("edit", { input }, acceptEdits([dir]));
		expect(result.behavior).toBe("ask");
		expect(safetyReason(result)).toBe("safetyCheck");
	});

	test("apply_patch payload inside the workspace allows in acceptEdits", () => {
		const dir = workspace();
		const input = `*** Begin Patch\n*** Add File: ${path.join(dir, "new.ts")}\n+hello\n*** End Patch`;
		const result = checkFileToolPermission("edit", { input }, acceptEdits([dir]));
		expect(result.behavior).toBe("allow");
	});

	test("ast_edit targeting a dangerous directory asks in acceptEdits", () => {
		const dir = workspace();
		const result = checkFileToolPermission(
			"ast_edit",
			{ ops: [{ pat: "X", out: "Y" }], paths: [path.join(dir, ".vscode", "settings.json")] },
			acceptEdits([dir]),
		);
		expect(result.behavior).toBe("ask");
		expect(safetyReason(result)).toBe("safetyCheck");
	});

	test("ast_edit inside the workspace allows in acceptEdits", () => {
		const dir = workspace();
		const result = checkFileToolPermission(
			"ast_edit",
			{ ops: [{ pat: "X", out: "Y" }], paths: [path.join(dir, "src")] },
			acceptEdits([dir]),
		);
		expect(result.behavior).toBe("allow");
	});
});

describe("agent configuration gate (CC isClaudeConfigFilePath parity)", () => {
	test("the agent dir's own config asks even under acceptEdits", () => {
		const dir = workspace();
		const agentDir = path.join(os.homedir(), ".omp", "agent");
		const result = checkFileToolPermission(
			"write",
			{ path: path.join(agentDir, "config.yml") },
			acceptEdits([dir], { agentDir }),
		);
		expect(result.behavior).toBe("ask");
		expect(safetyReason(result)).toBe("safetyCheck");
	});

	test("a relocated agent dir's config asks even though no dangerous segment is present", () => {
		const dir = workspace();
		const agentDir = mkdtempSync(path.join(os.tmpdir(), "omp-agentdir-"));
		const result = checkFileToolPermission(
			"write",
			{ path: path.join(agentDir, "config.yaml") },
			acceptEdits([dir], { agentDir }),
		);
		expect(result.behavior).toBe("ask");
		expect(safetyReason(result)).toBe("safetyCheck");
	});

	test("other files in a relocated agent dir stay ordinary workspace-style writes", () => {
		const dir = workspace();
		const agentDir = mkdtempSync(path.join(os.tmpdir(), "omp-agentdir-"));
		// Same temp root is NOT a working directory here, so this still asks —
		// but via workingDir, not the agent-config safety gate.
		const result = checkFileToolPermission(
			"write",
			{ path: path.join(agentDir, "notes.txt") },
			acceptEdits([dir], { agentDir }),
		);
		expect(result.behavior).toBe("ask");
		expect(safetyReason(result)).toBe("workingDir");
	});
});

describe("isAgentConfigFilePath", () => {
	const agentDir = path.join(os.homedir(), ".omp", "agent");

	test("agent-dir config layers match, others do not", () => {
		expect(isAgentConfigFilePath(path.join(agentDir, "config.yml"), agentDir)).toBe(true);
		expect(isAgentConfigFilePath(path.join(agentDir, "config.yaml"), agentDir)).toBe(true);
		expect(isAgentConfigFilePath(path.join(agentDir, "settings.json"), agentDir)).toBe(true);
		expect(isAgentConfigFilePath(path.join(agentDir, "plans", "p.md"), agentDir)).toBe(false);
		expect(isAgentConfigFilePath(path.join(agentDir, "other.txt"), agentDir)).toBe(false);
	});

	test("project settings under .omp/ and .claude/ match at any project root", () => {
		expect(isAgentConfigFilePath("/proj/.omp/settings.json", agentDir)).toBe(true);
		expect(isAgentConfigFilePath("/proj/.omp/settings.local.json", agentDir)).toBe(true);
		expect(isAgentConfigFilePath("/proj/.claude/settings.json", agentDir)).toBe(true);
		expect(isAgentConfigFilePath("/proj/.claude/settings.local.json", agentDir)).toBe(true);
		expect(isAgentConfigFilePath("/proj/.omp/config.yml", agentDir)).toBe(true);
	});

	test("similar names and nested dirs do not over-match", () => {
		expect(isAgentConfigFilePath("/proj/.omp/myconfig.yml", agentDir)).toBe(false);
		expect(isAgentConfigFilePath("/proj/config.yml", agentDir)).toBe(false);
		expect(isAgentConfigFilePath("/proj/.omp/sub/settings.json", agentDir)).toBe(false);
	});
});
