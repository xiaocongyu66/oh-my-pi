/**
 * Contract: the ported path-safety core blocks dangerous files/directories
 * (case-insensitively, over the whole symlink chain), contains paths
 * symmetrically against the working directories, matches gitignore-style
 * rule content, and flags dangerous removal targets.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	checkPathSafetyForAutoEdit,
	getPathsForPermissionCheck,
	isDangerousFilePathToAutoEdit,
	isDangerousRemovalPath,
	matchingPathRuleForInput,
	pathInAllowedWorkingPath,
	pathInWorkingPath,
} from "../../src/security/core/pathSafety";
import { EMPTY_RULES, parsedRulesFromEffective } from "../../src/security/core/rulesLoader";

function rulesFrom(behavior: "allow" | "deny" | "ask", toolName: string, ...contents: string[]) {
	return parsedRulesFromEffective(
		behavior === "allow" ? contents.map(c => `${toolName}(${c})`) : undefined,
		behavior === "deny" ? contents.map(c => `${toolName}(${c})`) : undefined,
		behavior === "ask" ? contents.map(c => `${toolName}(${c})`) : undefined,
	);
}

describe("dangerous files and directories", () => {
	test("sensitive files are dangerous anywhere, case-insensitively", () => {
		expect(isDangerousFilePathToAutoEdit("/home/user/.bashrc")).toBe(true);
		expect(isDangerousFilePathToAutoEdit("/home/user/proj/.GITCONFIG")).toBe(true);
		expect(isDangerousFilePathToAutoEdit("/home/user/proj/normal.ts")).toBe(false);
	});

	test("dangerous directory segments taint everything below", () => {
		expect(isDangerousFilePathToAutoEdit("/repo/.git/config")).toBe(true);
		expect(isDangerousFilePathToAutoEdit("/repo/.cLauDe/settings.json")).toBe(true);
		expect(isDangerousFilePathToAutoEdit("/repo/.omp/config.yml")).toBe(true);
		expect(isDangerousFilePathToAutoEdit("/repo/src/index.ts")).toBe(false);
	});

	test("the safety gate reports sensitive files as classifier-approvable", () => {
		const result = checkPathSafetyForAutoEdit("/repo/.git/config", ["/repo/.git/config"]);
		expect(result.safe).toBe(false);
		if (!result.safe) expect(result.classifierApprovable).toBe(true);
	});
});

describe("symlink-aware representations", () => {
	test("the full symlink chain is collected", async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "omp-paths-"));
		const target = path.join(dir, "real-target.txt");
		writeFileSync(target, "x");
		const link = path.join(dir, "link.txt");
		symlinkSync(target, link);
		const paths = getPathsForPermissionCheck(link);
		expect(paths).toContain(link);
		expect(paths.some(p => path.resolve(p) === path.resolve(target))).toBe(true);
	});

	test("dangling symlinks still surface their intended target", async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "omp-paths-"));
		const missing = path.join(dir, "does-not-exist.conf");
		const link = path.join(dir, "evil.conf");
		symlinkSync(missing, link);
		const paths = getPathsForPermissionCheck(link);
		expect(paths.some(p => p.includes("does-not-exist"))).toBe(true);
	});

	test("writes through a symlinked directory resolve to the real parent", async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "omp-paths-"));
		const real = path.join(dir, "realdir");
		mkdirSync(real);
		const alias = path.join(dir, "aliasdir");
		symlinkSync(real, alias);
		const paths = getPathsForPermissionCheck(path.join(alias, "new-file.txt"));
		expect(paths.some(p => p.startsWith(realpathSync(real)))).toBe(true);
	});
});

describe("working-directory containment", () => {
	test("inside/outside at boundaries", () => {
		expect(pathInWorkingPath("/repo/src/a.ts", "/repo")).toBe(true);
		expect(pathInWorkingPath("/repo", "/repo")).toBe(true);
		expect(pathInWorkingPath("/other/a.ts", "/repo")).toBe(false);
		expect(pathInWorkingPath("/repo/../other/a.ts", "/repo")).toBe(false);
		expect(pathInWorkingPath("/REPO/A.TS", "/repo")).toBe(true);
	});

	test("a symlink escaping the workspace is not inside it", async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "omp-paths-"));
		const outside = mkdtempSync(path.join(os.tmpdir(), "omp-outside-"));
		const escapeLink = path.join(dir, "escape");
		symlinkSync(outside, escapeLink);
		const inner = path.join(escapeLink, "payload.txt");
		expect(pathInAllowedWorkingPath(inner, [dir])).toBe(false);
	});

	test("additional directories extend the workspace", async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "omp-paths-"));
		const extra = mkdtempSync(path.join(os.tmpdir(), "omp-extra-"));
		const inner = path.join(dir, "a.ts");
		const foreign = path.join(extra, "b.ts");
		expect(pathInAllowedWorkingPath(inner, [dir])).toBe(true);
		expect(pathInAllowedWorkingPath(foreign, [dir])).toBe(false);
		expect(pathInAllowedWorkingPath(foreign, [dir, extra])).toBe(true);
	});
});

describe("gitignore-style rule content matching", () => {
	const cwd = process.cwd();

	test("project-relative patterns bind under cwd", () => {
		const rules = rulesFrom("deny", "edit", "./secrets/**");
		const hit = matchingPathRuleForInput(path.join(cwd, "secrets", "key.pem"), rules, "deny", ["edit", "write"]);
		expect(hit).not.toBeNull();
		expect(hit?.ruleValue.ruleContent).toBe("./secrets/**");
		expect(matchingPathRuleForInput(path.join(cwd, "src", "a.ts"), rules, "deny", ["edit", "write"])).toBeNull();
	});

	test("the directory itself matches its /** rule", () => {
		const rules = rulesFrom("deny", "read", "./secrets/**");
		expect(matchingPathRuleForInput(path.join(cwd, "secrets"), rules, "deny", ["read"])).not.toBeNull();
	});

	test("double-slash patterns are absolute", () => {
		const rules = rulesFrom("deny", "read", "//etc/**");
		expect(matchingPathRuleForInput("/etc/passwd", rules, "deny", ["read"])).not.toBeNull();
		expect(matchingPathRuleForInput("/usr/share/doc", rules, "deny", ["read"])).toBeNull();
	});

	test("home-relative patterns bind under ~", () => {
		const rules = rulesFrom("deny", "edit", "~/.ssh/**");
		expect(
			matchingPathRuleForInput(path.join(os.homedir(), ".ssh", "id_ed25519"), rules, "deny", ["edit"]),
		).not.toBeNull();
	});

	test("slashless patterns match by basename at any depth", () => {
		const rules = rulesFrom("deny", "read", ".env");
		expect(matchingPathRuleForInput(path.join(cwd, "a", "b", ".env"), rules, "deny", ["read"])).not.toBeNull();
		expect(matchingPathRuleForInput(path.join(cwd, "a", ".env.production"), rules, "deny", ["read"])).toBeNull();
	});

	test("star matches within one segment only", () => {
		const rules = rulesFrom("allow", "read", "src/*.ts");
		expect(matchingPathRuleForInput(path.join(cwd, "src", "a.ts"), rules, "allow", ["read"])).not.toBeNull();
		expect(matchingPathRuleForInput(path.join(cwd, "src", "deep", "a.ts"), rules, "allow", ["read"])).toBeNull();
	});

	test("double-star spans segments", () => {
		const rules = rulesFrom("allow", "read", "src/**.ts");
		expect(matchingPathRuleForInput(path.join(cwd, "src", "deep", "a.ts"), rules, "allow", ["read"])).not.toBeNull();
	});

	test("no rules means no match", () => {
		expect(matchingPathRuleForInput("/etc/passwd", EMPTY_RULES, "deny", ["read"])).toBeNull();
	});
});

describe("dangerous removal targets", () => {
	test("roots, home, and direct children are dangerous", () => {
		expect(isDangerousRemovalPath("/")).toBe(true);
		expect(isDangerousRemovalPath("/usr")).toBe(true);
		expect(isDangerousRemovalPath(os.homedir())).toBe(true);
		expect(isDangerousRemovalPath("/usr/local/share")).toBe(false);
		expect(isDangerousRemovalPath("*")).toBe(true);
		expect(isDangerousRemovalPath("/srv/data/*")).toBe(true);
	});
});
