import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
	ccLocalMemoryDir,
	ccProjectMemoryDir,
	escapeClaudeProjectPath,
	listMemorySources,
	resolveWriteTarget,
	type MemorySource,
} from "../../src/memory/claudemd-backend/paths";
import { claudemdMemoryDir } from "../../src/memory/claudemd-backend/prompts";

let tempDir: string | undefined;

async function makeTempDir(): Promise<string> {
	tempDir = await mkdtemp(path.join(os.tmpdir(), "claudemd-paths-"));
	return tempDir;
}

afterEach(async () => {
	if (tempDir) {
		await rm(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

describe("escapeClaudeProjectPath", () => {
	it("matches CC's rule: every non-alphanumeric becomes a dash", () => {
		expect(escapeClaudeProjectPath("/root/oh-my-pi")).toBe("-root-oh-my-pi");
		expect(escapeClaudeProjectPath("/home/user/my.project")).toBe("-home-user-my-project");
		expect(escapeClaudeProjectPath("/tmp/a b/c")).toBe("-tmp-a-b-c");
	});

	it("escapes CJK per character", () => {
		expect(escapeClaudeProjectPath("/home/用户/项目")).toBe("-home------");
	});

	it("keeps worktree-suffixed paths distinguishable only through dashes", () => {
		expect(escapeClaudeProjectPath("/repo--claude-worktrees-topic")).toBe("-repo--claude-worktrees-topic");
	});
});

describe("ccProjectMemoryDir", () => {
	it("joins configDir/projects/<escaped>/memory", () => {
		expect(ccProjectMemoryDir("/repo/proj", "/cc")).toBe(path.join("/cc", "projects", "-repo-proj", "memory"));
	});
});

describe("listMemorySources", () => {
	const agentDir = "/agent";
	const projectDir = "/project";
	const ompDir = claudemdMemoryDir(agentDir);
	const ccDir = ccProjectMemoryDir(projectDir, "/cc");
	const ccLocal = ccLocalMemoryDir(projectDir);

	function probe(existing: Set<string>) {
		return async (target: string) => existing.has(target);
	}

	it("off returns only the omp source even when everything exists", async () => {
		const sources = await listMemorySources({
			agentDir,
			projectDir,
			shared: "off",
			claudeConfigDir: "/cc",
			exists: probe(new Set([ccDir, ccLocal, "/cc"])),
		});
		expect(sources).toEqual([{ dir: ompDir, kind: "omp", writable: true }]);
	});

	it("auto without any Claude directory returns only the omp source", async () => {
		const sources = await listMemorySources({
			agentDir,
			projectDir,
			shared: "auto",
			claudeConfigDir: "/cc",
			exists: probe(new Set()),
		});
		expect(sources).toEqual([{ dir: ompDir, kind: "omp", writable: true }]);
	});

	it("auto adopts the CC project dir when its memory dir exists", async () => {
		const sources = await listMemorySources({
			agentDir,
			projectDir,
			shared: "auto",
			claudeConfigDir: "/cc",
			exists: probe(new Set([ccDir])),
		});
		expect(sources).toEqual([
			{ dir: ompDir, kind: "omp", writable: true },
			{ dir: ccDir, kind: "cc-project", writable: true },
		]);
	});

	it("auto adopts the CC project dir on the weaker config-dir-exists signal", async () => {
		const sources = await listMemorySources({
			agentDir,
			projectDir,
			shared: "auto",
			claudeConfigDir: "/cc",
			exists: probe(new Set(["/cc"])),
		});
		expect(sources.map(s => s.kind)).toEqual(["omp", "cc-project"]);
	});

	it("on always joins the CC project dir", async () => {
		const sources = await listMemorySources({
			agentDir,
			projectDir,
			shared: "on",
			claudeConfigDir: "/cc",
			exists: probe(new Set()),
		});
		expect(sources.map(s => s.kind)).toEqual(["omp", "cc-project"]);
	});

	it("cc-local joins only when present and is always read-only", async () => {
		const sources = await listMemorySources({
			agentDir,
			projectDir,
			shared: "off",
			claudeConfigDir: "/cc",
			exists: probe(new Set([ccLocal])),
		});
		// `off` skips every Claude source, even the read-only one.
		expect(sources.map(s => s.kind)).toEqual(["omp"]);

		const shared = await listMemorySources({
			agentDir,
			projectDir,
			shared: "auto",
			claudeConfigDir: "/cc",
			exists: probe(new Set([ccLocal, ccDir])),
		});
		expect(shared).toEqual([
			{ dir: ompDir, kind: "omp", writable: true },
			{ dir: ccLocal, kind: "cc-local", writable: false },
			{ dir: ccDir, kind: "cc-project", writable: true },
		]);
	});

	it("reads never create directories on the default exists probe", async () => {
		const base = await makeTempDir();
		const agent = path.join(base, "agent");
		const project = path.join(base, "project");
		const config = path.join(base, "missing-cc");
		const sources = await listMemorySources({
			agentDir: agent,
			projectDir: project,
			shared: "auto",
			claudeConfigDir: config,
		});
		expect(sources).toEqual([{ dir: claudemdMemoryDir(agent), kind: "omp", writable: true }]);
		// Only the explicit write below creates it.
		await expect(mkdir(config, { recursive: false })).resolves.toBeUndefined();
	});
});

describe("cc-project key and override chain (CC memdir/paths.ts port)", () => {
	const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
	const identity = ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false"];
	let originalRemoteBase: string | undefined;

	beforeEach(() => {
		originalRemoteBase = process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR;
		delete process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR;
	});
	afterEach(() => {
		if (originalRemoteBase === undefined) delete process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR;
		else process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR = originalRemoteBase;
	});

	async function ccDirOf(projectDir: string, configDir = "/cc-missing"): Promise<string> {
		const sources = await listMemorySources({
			agentDir: "/agent",
			projectDir,
			shared: "on",
			claudeConfigDir: configDir,
		});
		const cc = sources.find(s => s.kind === "cc-project");
		if (!cc) throw new Error("no cc-project source");
		return cc.dir;
	}

	it("keys by the canonical git root, shared across worktrees and subdirectories", async () => {
		const base = await makeTempDir();
		const main = path.join(base, "main");
		const wt = path.join(base, "wt");
		await mkdir(main, { recursive: true });
		const git = promisify(execFile);
		await git("git", [...identity, "init", main], { env: gitEnv });
		await writeFile(path.join(main, "f.txt"), "x");
		await git("git", ["-C", main, ...identity, "add", "-A"], { env: gitEnv });
		await git("git", ["-C", main, ...identity, "commit", "-m", "init"], { env: gitEnv });
		await git("git", ["-C", main, "worktree", "add", wt], { env: gitEnv });

		const expected = path.join("/cc-missing", "projects", escapeClaudeProjectPath(main), "memory");
		expect(await ccDirOf(path.join(main, "src", "deep"))).toBe(expected);
		expect(await ccDirOf(wt)).toBe(expected);
		expect(await ccDirOf(path.join(wt, "sub"))).toBe(expected);
	}, 30000);

	it("a fake worktree layout failing CC's guards falls back to the plain git root", async () => {
		const base = await makeTempDir();
		// Attacker-controlled repo: `.git` file points at a gitdir whose
		// commondir escapes the <commonDir>/worktrees/<name> layout.
		const evil = path.join(base, "evil");
		// Guard 1: the gitdir is not a child of <commondir>/worktrees.
		const fakeGitdir = path.join(base, "elsewhere");
		await mkdir(fakeGitdir, { recursive: true });
		await writeFile(path.join(fakeGitdir, "commondir"), path.join(base, "victim"));
		await mkdir(evil, { recursive: true });
		await writeFile(path.join(evil, ".git"), `gitdir: ${fakeGitdir}\n`);
		const expected = path.join("/cc-missing", "projects", escapeClaudeProjectPath(evil), "memory");
		expect(await ccDirOf(evil)).toBe(expected);
	});

	it("CLAUDE_CODE_REMOTE_MEMORY_DIR replaces the projects base (CC getMemoryBaseDir)", async () => {
		process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR = "/remote-base";
		expect(await ccDirOf("/project")).toBe(path.join("/remote-base", "projects", "-project", "memory"));
	});

	it("autoMemoryDirectory from trusted settings wins; committed project settings never do", async () => {
		const base = await makeTempDir();
		const project = path.join(base, "project");
		await mkdir(path.join(project, ".claude"), { recursive: true });
		// Committed project settings: ignored (injection guard).
		await writeFile(
			path.join(project, ".claude", "settings.json"),
			JSON.stringify({ autoMemoryDirectory: "/evil/path" }),
		);
		expect(await ccDirOf(project)).toBe(ccProjectMemoryDir(project, "/cc-missing"));

		// Personal local settings: trusted, wins.
		await writeFile(
			path.join(project, ".claude", "settings.local.json"),
			JSON.stringify({ autoMemoryDirectory: "/custom/mem" }),
		);
		expect(await ccDirOf(project)).toBe("/custom/mem");
	});

	it("invalid autoMemoryDirectory values are rejected (CC validateMemoryPath)", async () => {
		const base = await makeTempDir();
		const project = path.join(base, "project");
		await mkdir(path.join(project, ".claude"), { recursive: true });
		for (const bad of ["../escape", "/", "/a", "~/..", "relative/dir", "//evil", "\\\\server\\share"]) {
			await writeFile(
				path.join(project, ".claude", "settings.local.json"),
				JSON.stringify({ autoMemoryDirectory: bad }),
			);
			expect(await ccDirOf(project)).toBe(ccProjectMemoryDir(project, "/cc-missing"));
		}
	});
});

describe("resolveWriteTarget", () => {
	const omp: MemorySource = { dir: "/agent/memory", kind: "omp", writable: true };
	const ccLocal: MemorySource = { dir: "/project/.claude/memory", kind: "cc-local", writable: false };
	const ccProject: MemorySource = { dir: "/cc/projects/-project/memory", kind: "cc-project", writable: true };

	it("prefers the CC project dir when present", () => {
		expect(resolveWriteTarget([omp, ccLocal, ccProject])).toBe(ccProject.dir);
	});

	it("falls back to the omp dir without a CC project source", () => {
		expect(resolveWriteTarget([omp, ccLocal])).toBe(omp.dir);
	});

	it("throws only when no writable source exists at all", () => {
		expect(() => resolveWriteTarget([ccLocal])).toThrow();
	});
});
