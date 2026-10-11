import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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
