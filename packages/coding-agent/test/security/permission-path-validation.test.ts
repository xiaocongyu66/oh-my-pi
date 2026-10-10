/**
 * Contract: validatePath rejects the TOCTOU classes (tilde variants, `$`/`%`/
 * `=` expansion), refuses globs in write operations while validating the base
 * directory for reads, and otherwise follows deny → safety → working-dir →
 * allow ordering.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { formatDirectoryList, getGlobBaseDirectory, validatePath } from "../../src/security/core/pathValidation";
import type { PathPermissionOptions } from "../../src/security/core/pathValidation";
import { EMPTY_RULES, parsedRulesFromEffective } from "../../src/security/core/rulesLoader";

function options(overrides: Partial<PathPermissionOptions> = {}): PathPermissionOptions {
	return {
		rules: EMPTY_RULES,
		workingDirectories: [process.cwd()],
		mode: "default",
		...overrides,
	};
}

describe("validatePath rejection classes", () => {
	test("tilde variants and expansion syntax require approval", () => {
		const opts = options();
		expect(validatePath("~root/.ssh/id_rsa", process.cwd(), opts, "read").allowed).toBe(false);
		expect(validatePath("$HOME/.ssh/id_rsa", process.cwd(), opts, "read").allowed).toBe(false);
		expect(validatePath("%TEMP%\\x", process.cwd(), opts, "read").allowed).toBe(false);
		expect(validatePath("=rg", process.cwd(), opts, "read").allowed).toBe(false);
		expect(validatePath("//server/share/x", process.cwd(), opts, "read").allowed).toBe(false);
	});

	test("plain home expansion still works", () => {
		const result = validatePath("~/nonexistent-file-xyz", process.cwd(), options({ mode: "acceptEdits" }), "read");
		// read outside the workspace is refused without an allow rule
		expect(result.allowed).toBe(false);
		expect(result.decisionReason?.type).toBeUndefined();
	});

	test("globs are refused for writes and base-validated for reads", async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "omp-validate-"));
		const opts = options({ workingDirectories: [dir] });
		expect(validatePath(path.join(dir, "*.txt"), process.cwd(), opts, "write").allowed).toBe(false);
		const read = validatePath(path.join(dir, "*.txt"), process.cwd(), opts, "read");
		expect(read.allowed).toBe(true);
	});
});

describe("isPathAllowed ordering", () => {
	test("deny rules beat the working directory", async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "omp-validate-"));
		const opts = options({
			workingDirectories: [dir],
			rules: parsedRulesFromEffective(undefined, [`Read(//${dir.slice(1)}/secret.txt)`]),
		});
		const result = validatePath(path.join(dir, "secret.txt"), process.cwd(), opts, "read");
		expect(result.allowed).toBe(false);
		expect(result.decisionReason?.type).toBe("rule");
	});

	test("acceptEdits allows workspace writes, default mode does not", async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "omp-validate-"));
		const inside = path.join(dir, "a.txt");
		expect(validatePath(inside, process.cwd(), options({ workingDirectories: [dir] }), "write").allowed).toBe(false);
		expect(
			validatePath(inside, process.cwd(), options({ workingDirectories: [dir], mode: "acceptEdits" }), "write").allowed,
		).toBe(true);
	});

	test("writes to protected paths are refused even with an allow rule", async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "omp-validate-"));
		const gitConfig = path.join(dir, ".git", "config");
		const opts = options({
			workingDirectories: [dir],
			mode: "acceptEdits",
			rules: parsedRulesFromEffective([`Edit(//${dir.slice(1)}/.git/**)`]),
		});
		const result = validatePath(gitConfig, process.cwd(), opts, "write");
		expect(result.allowed).toBe(false);
		expect(result.decisionReason?.type).toBe("safetyCheck");
	});
});

describe("helpers", () => {
	test("glob base directory", () => {
		expect(getGlobBaseDirectory("/path/to/*.txt")).toBe("/path/to");
		expect(getGlobBaseDirectory("/plain/file.txt")).toBe("/plain/file.txt");
		expect(getGlobBaseDirectory("*.txt")).toBe(".");
	});

	test("directory list formatting", () => {
		expect(formatDirectoryList(["/a", "/b"])).toBe("'/a', '/b'");
		const six = ["/1", "/2", "/3", "/4", "/5", "/6"];
		expect(formatDirectoryList(six)).toBe("'/1', '/2', '/3', '/4', '/5', and 1 more");
	});
});
