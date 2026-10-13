/**
 * Contract: the `.claude/` JSON write side reproduces Claude Code's
 * five-step update semantics — directory auto-creation, corrupt-JSON
 * protection (error, bytes untouched), array-replace / undefined-delete
 * merging, atomic two-space-indented writes with a trailing newline — plus
 * CC's *global*-gitignore maintenance (`~/.config/git/ignore`, port of
 * gitignore.ts:53-110: repo-only, skip-when-already-ignored, substring
 * idempotence) and normalized rule de-duplication.
 * Everything runs inside fresh mkdtemp directories; HOME is redirected to a
 * fake home (both `os.homedir()` via spyOn and the env vars the spawned
 * `git` sees, so `check-ignore` cannot be influenced by the real
 * ~/.config/git/ignore either). The real ~/.config, ~/.claude and ~/.omp
 * are never touched.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import {
	appendPermissionRule,
	ensureGitignoreEntry,
	readClaudeSettingsFile,
	writeClaudeSettingsJson,
} from "../../src/discovery/claude-write";

describe("claude-write", () => {
	let tempDir!: string;
	let fakeHome: { homeDir: string; globalIgnorePath: string; restore: () => void } | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-claude-write-"));
	});

	afterEach(() => {
		fakeHome?.restore();
		fakeHome = undefined;
		removeSyncWithRetries(tempDir);
	});

	/** Turns `dir` into a git repo so the CC gitignore path activates. */
	const initRepo = (dir: string): void => {
		execFileSync("git", ["init", "--quiet", dir], { stdio: "ignore" });
	};

	/**
	 * Redirects HOME to a fresh temp dir: `os.homedir()` via spyOn (bun
	 * caches the env HOME at process start, so process.env alone would not
	 * affect it) plus process.env.HOME/XDG_CONFIG_HOME so the `git`
	 * subprocesses spawned by check-ignore never consult the real
	 * ~/.config/git/ignore.
	 */
	const isolateHome = (): { homeDir: string; globalIgnorePath: string; restore: () => void } => {
		const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-claude-write-home-"));
		const previousHome = process.env.HOME;
		const previousXdg = process.env.XDG_CONFIG_HOME;
		process.env.HOME = homeDir;
		process.env.XDG_CONFIG_HOME = path.join(homeDir, ".config");
		const homedirSpy = spyOn(os, "homedir").mockReturnValue(homeDir);
		const scope = {
			homeDir,
			globalIgnorePath: path.join(homeDir, ".config", "git", "ignore"),
			restore: () => {
				homedirSpy.mockRestore();
				if (previousHome === undefined) delete process.env.HOME;
				else process.env.HOME = previousHome;
				if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
				else process.env.XDG_CONFIG_HOME = previousXdg;
				removeSyncWithRetries(homeDir);
			},
		};
		fakeHome = scope;
		return scope;
	};

	const settingsPath = () => path.join(tempDir, ".claude", "settings.local.json");

	describe("readClaudeSettingsFile", () => {
		test("missing file reads as null", async () => {
			expect(await readClaudeSettingsFile(settingsPath())).toBeNull();
		});

		test("corrupt JSON reads as null", async () => {
			fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
			fs.writeFileSync(settingsPath(), "{ not json");
			expect(await readClaudeSettingsFile(settingsPath())).toBeNull();
		});

		test("non-object JSON reads as null", async () => {
			const filePath = path.join(tempDir, "scalar.json");
			fs.writeFileSync(filePath, "[1, 2]");
			expect(await readClaudeSettingsFile(filePath)).toBeNull();
		});

		test("valid object JSON is returned", async () => {
			const filePath = path.join(tempDir, "ok.json");
			fs.writeFileSync(filePath, '{"permissions":{"allow":["Bash"]}}');
			expect(await readClaudeSettingsFile(filePath)).toEqual({ permissions: { allow: ["Bash"] } });
		});
	});

	describe("writeClaudeSettingsJson", () => {
		test("creates the parent directory automatically", async () => {
			const result = await writeClaudeSettingsJson(settingsPath(), { permissions: { allow: ["Bash"] } });
			expect(result.error).toBeUndefined();
			expect(JSON.parse(fs.readFileSync(settingsPath(), "utf8"))).toEqual({ permissions: { allow: ["Bash"] } });
		});

		test("corrupt JSON returns an error and leaves the original bytes untouched", async () => {
			fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
			const broken = "{ broken,,,";
			fs.writeFileSync(settingsPath(), broken);
			const result = await writeClaudeSettingsJson(settingsPath(), { permissions: { allow: ["Bash"] } });
			expect(result.error).toBeInstanceOf(Error);
			expect(fs.readFileSync(settingsPath(), "utf8")).toBe(broken);
		});

		test("merges deeply: arrays replace wholesale, explicit undefined deletes keys", async () => {
			fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
			fs.writeFileSync(
				settingsPath(),
				JSON.stringify(
					{
						permissions: { allow: ["Old1", "Old2"], deny: ["WebFetch"] },
						model: "keep-me",
						doomed: { nested: true },
					},
					null,
					2,
				),
			);

			const result = await writeClaudeSettingsJson(settingsPath(), {
				permissions: { allow: ["Bash(git diff:*)"] },
				doomed: undefined,
				env: { FOO: "bar" },
			});
			expect(result.error).toBeUndefined();

			expect(JSON.parse(fs.readFileSync(settingsPath(), "utf8"))).toEqual({
				permissions: { allow: ["Bash(git diff:*)"], deny: ["WebFetch"] },
				model: "keep-me",
				env: { FOO: "bar" },
			});
		});

		test("writes two-space indented JSON with a trailing newline", async () => {
			await writeClaudeSettingsJson(settingsPath(), { permissions: { allow: ["Bash"] } });
			const content = fs.readFileSync(settingsPath(), "utf8");
			expect(content.endsWith("}\n")).toBe(true);
			expect(content).toContain('\n  "permissions"');
			expect(content).toContain('\n    "allow"');
		});

		test("leaves no temp files behind after successful writes", async () => {
			await writeClaudeSettingsJson(settingsPath(), { a: 1 });
			await writeClaudeSettingsJson(settingsPath(), { b: 2 });
			const leftovers = fs.readdirSync(path.dirname(settingsPath())).filter(name => name.includes(".tmp"));
			expect(leftovers).toEqual([]);
		});
	});

	describe("ensureGitignoreEntry", () => {
		// CC port (gitignore.ts:53-110): the doublestar rule goes into the
		// GLOBAL gitignore (~/.config/git/ignore), never the project one, and
		// only inside a git repo.

		test("creates the global ignore inside a git repo and never touches the project .gitignore", async () => {
			initRepo(tempDir);
			const home = isolateHome();
			await ensureGitignoreEntry(tempDir);
			expect(fs.readFileSync(home.globalIgnorePath, "utf8")).toBe("**/.claude/settings.local.json\n");
			expect(fs.existsSync(path.join(tempDir, ".gitignore"))).toBe(false);
		});

		test("is idempotent: two calls append only once", async () => {
			initRepo(tempDir);
			const home = isolateHome();
			await ensureGitignoreEntry(tempDir);
			await ensureGitignoreEntry(tempDir);
			const content = fs.readFileSync(home.globalIgnorePath, "utf8");
			expect(content.match(/\*\*\/\.claude\/settings\.local\.json/g)).toHaveLength(1);
		});

		test("recognizes an existing entry in the global file regardless of surrounding whitespace", async () => {
			initRepo(tempDir);
			const home = isolateHome();
			fs.mkdirSync(path.dirname(home.globalIgnorePath), { recursive: true });
			const seeded = "build/\n  **/.claude/settings.local.json  \n";
			fs.writeFileSync(home.globalIgnorePath, seeded);
			await ensureGitignoreEntry(tempDir);
			expect(fs.readFileSync(home.globalIgnorePath, "utf8")).toBe(seeded);
		});

		test("adds a separating newline when the global file lacks a trailing one", async () => {
			initRepo(tempDir);
			const home = isolateHome();
			fs.mkdirSync(path.dirname(home.globalIgnorePath), { recursive: true });
			fs.writeFileSync(home.globalIgnorePath, "node_modules");
			await ensureGitignoreEntry(tempDir);
			expect(fs.readFileSync(home.globalIgnorePath, "utf8")).toBe("node_modules\n**/.claude/settings.local.json\n");
		});

		test("no-ops outside a git repo: the global file is never created", async () => {
			const home = isolateHome();
			await ensureGitignoreEntry(tempDir);
			expect(fs.existsSync(home.globalIgnorePath)).toBe(false);
			expect(fs.existsSync(path.join(home.homeDir, ".config"))).toBe(false);
		});

		test("no-ops when the project .gitignore already ignores the path", async () => {
			initRepo(tempDir);
			const home = isolateHome();
			fs.writeFileSync(path.join(tempDir, ".gitignore"), ".claude/settings.local.json\n");
			await ensureGitignoreEntry(tempDir);
			expect(fs.existsSync(home.globalIgnorePath)).toBe(false);
		});
	});

	describe("appendPermissionRule", () => {
		test("appends to a fresh file and gitignores the local settings globally (CC)", async () => {
			initRepo(tempDir);
			const home = isolateHome();
			const result = await appendPermissionRule(tempDir, "allow", ["Bash(git diff:*)", "WebFetch"]);
			expect(result.error).toBeUndefined();
			expect(JSON.parse(fs.readFileSync(settingsPath(), "utf8"))).toEqual({
				permissions: { allow: ["Bash(git diff:*)", "WebFetch"] },
			});
			expect(fs.readFileSync(home.globalIgnorePath, "utf8")).toContain("**/.claude/settings.local.json");
			expect(fs.existsSync(path.join(tempDir, ".gitignore"))).toBe(false);
		});

		test('normalizes "Tool(*)" and "Tool" to the same rule (no duplicate on disk)', async () => {
			fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
			fs.writeFileSync(settingsPath(), JSON.stringify({ permissions: { allow: ["Bash(*)"] } }, null, 2));

			const result = await appendPermissionRule(tempDir, "allow", ["Bash"]);
			expect(result.error).toBeUndefined();
			expect(JSON.parse(fs.readFileSync(settingsPath(), "utf8")).permissions.allow).toEqual(["Bash(*)"]);
		});

		test("a second append of the same rule does not duplicate", async () => {
			await appendPermissionRule(tempDir, "deny", ["WebFetch"]);
			await appendPermissionRule(tempDir, "deny", ["WebFetch"]);
			expect(JSON.parse(fs.readFileSync(settingsPath(), "utf8")).permissions.deny).toEqual(["WebFetch"]);
		});

		test("preserves other behaviors while replacing the targeted group", async () => {
			fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
			fs.writeFileSync(
				settingsPath(),
				JSON.stringify({ permissions: { allow: ["Read"], ask: ["task"] }, model: "x" }, null, 2),
			);

			await appendPermissionRule(tempDir, "allow", ["Bash"]);
			const written = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
			expect(written.permissions.allow).toEqual(["Read", "Bash"]);
			expect(written.permissions.ask).toEqual(["task"]);
			expect(written.model).toBe("x");
		});

		test("corrupt settings file surfaces an error instead of being overwritten", async () => {
			fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
			fs.writeFileSync(settingsPath(), "{ oops");
			const result = await appendPermissionRule(tempDir, "allow", ["Bash"]);
			expect(result.error).toBeInstanceOf(Error);
			expect(fs.readFileSync(settingsPath(), "utf8")).toBe("{ oops");
		});
	});
});
