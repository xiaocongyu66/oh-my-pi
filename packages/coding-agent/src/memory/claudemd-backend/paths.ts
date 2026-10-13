/**
 * Memory source resolution for Claude-Code-directory interop.
 *
 * Three source kinds feed the claudemd backend:
 * - `omp`: `${agentDir}/memory/` — always present, writable only when no
 *   Claude project directory is active (it is the default write target and
 *   the only directory `clear()` may delete).
 * - `cc-project`: `<memoryBase>/projects/<escaped canonical-git-root>/memory/`
 *   — Claude Code's per-project memory directory (CC keys by git root so
 *   worktrees/subdirectories share one memory; memdir/paths.ts:203-205).
 *   Trusted-source overrides (`autoMemoryDirectory` in user/local settings —
 *   never the committed project settings; CLAUDE_CODE_REMOTE_MEMORY_DIR) win
 *   first, exactly as in CC. When active it is the write target (CC
 *   reads/writes the same files, zero format migration).
 * - `cc-local`: `<project>/.claude/memory/` — checked-in project memory,
 *   always read-only for omp.
 *
 * Escape rule matches CC: every character outside `[A-Za-z0-9]` becomes `-`
 * (CJK escapes per character). Collisions (`/a b` vs `/a-b`) are inherent to
 * CC's own scheme; sharing the directory is what makes them consistent.
 *
 * Read paths never create Claude directories — only explicit writes (save,
 * extraction/dream applying to the resolved write target) do.
 */

import { readFile, realpath, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveClaudePaths } from "../../config/claude-paths";
import { readClaudeSettingsFile } from "../../discovery/claude-write";
import { claudemdMemoryDir } from "./prompts";

export type ClaudeSharedMode = "off" | "auto" | "on";
export type MemorySourceKind = "omp" | "cc-project" | "cc-local";

export interface MemorySource {
	dir: string;
	kind: MemorySourceKind;
	writable: boolean;
}

/** Claude Code's project-directory escape: non-alphanumerics all become `-`. */
export function escapeClaudeProjectPath(projectPath: string): string {
	return projectPath.replace(/[^A-Za-z0-9]/g, "-");
}

/** CC's per-project memory dir: `<base>/projects/<escaped>/memory`. */
export function ccProjectMemoryDir(projectDir: string, claudeConfigDir?: string): string {
	const configDir = claudeConfigDir ?? resolveClaudePaths().configDir;
	return path.join(configDir, "projects", escapeClaudeProjectPath(projectDir), "memory");
}

/** Walk up from `start` looking for a `.git` entry (directory or worktree gitfile). Port of CC findGitRoot (git.ts:99-109). */
async function findGitRoot(start: string): Promise<string | null> {
	let current = path.resolve(start);
	for (;;) {
		try {
			await stat(path.join(current, ".git"));
			return current;
		} catch {
			/* keep walking up */
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/**
 * Port of CC findCanonicalGitRoot (git.ts:123-210): a linked worktree resolves
 * through `.git` gitfile → `gitdir:` → `commondir` to the MAIN repo working
 * directory so all worktrees share one memory key. CC's two-part injection
 * guard is preserved: the commondir file we just read must live under
 * `<commonDir>/worktrees/<name>` AND that entry's `gitdir` must point back at
 * `<gitRoot>/.git` — otherwise the worktree layout is attacker-controlled and
 * the plain git root is used. Submodules (no `commondir`) and bare-repo
 * worktrees follow CC's fallbacks (input root / common dir itself).
 */
async function resolveCanonicalRoot(gitRoot: string): Promise<string> {
	try {
		const gitContent = (await readFile(path.join(gitRoot, ".git"), "utf-8")).trim();
		if (!gitContent.startsWith("gitdir:")) return gitRoot;
		const worktreeGitDir = path.resolve(gitRoot, gitContent.slice("gitdir:".length).trim());
		const commonDirRaw = (await readFile(path.join(worktreeGitDir, "commondir"), "utf-8")).trim();
		const commonDir = path.resolve(worktreeGitDir, commonDirRaw);
		// Guard 1: worktreeGitDir must be a direct child of <commonDir>/worktrees.
		if (path.resolve(path.dirname(worktreeGitDir)) !== path.join(commonDir, "worktrees")) return gitRoot;
		// Guard 2: the entry's `gitdir` backlink must resolve to <gitRoot>/.git
		// (realpath both sides — git writes realpath'd paths).
		const backlinkTarget = (await readFile(path.join(worktreeGitDir, "gitdir"), "utf-8")).trim();
		const backlink = await realpath(backlinkTarget);
		if (backlink !== path.join(await realpath(gitRoot), ".git")) return gitRoot;
		// Bare-repo worktrees: common dir is not inside a working tree (CC #27994).
		if (path.basename(commonDir) !== ".git") return commonDir.normalize("NFC");
		return path.dirname(commonDir).normalize("NFC");
	} catch {
		return gitRoot;
	}
}

/** CC getAutoMemBase (memdir/paths.ts:203-205): canonical git root when inside a repo, else the project root. */
export async function ccMemoryKey(cwd: string): Promise<string> {
	const gitRoot = await findGitRoot(cwd);
	if (!gitRoot) return cwd;
	return resolveCanonicalRoot(gitRoot);
}

/**
 * Port of CC validateMemoryPath (memdir/paths.ts:119-150) minus the trailing
 * separator contract: reject relative paths, root/near-root, Windows drive
 * roots, UNC paths and null bytes — these would widen a read/write allowlist.
 */
function validateMemoryPath(candidate: string | undefined, expandHome: boolean): string | undefined {
	if (!candidate) return undefined;
	let resolved = candidate;
	if (expandHome && resolved.startsWith("~/")) {
		const rest = resolved.slice(2);
		const normRest = path.normalize(rest || ".");
		if (normRest === "." || normRest === "..") return undefined;
		resolved = path.join(os.homedir(), rest);
	}
	// CC checks `//` after normalize() because Node preserves leading double
	// slashes; Bun collapses them to `/`, so the UNC check must precede it.
	if (resolved.startsWith("//") || resolved.startsWith("\\\\")) return undefined;
	const normalized = path.normalize(resolved).replace(/[/\\]+$/, "");
	if (
		!path.isAbsolute(normalized) ||
		normalized.length < 3 ||
		/^[A-Za-z]:$/.test(normalized) ||
		normalized.includes("\0")
	) {
		return undefined;
	}
	return normalized.normalize("NFC");
}

/**
 * Port of CC getAutoMemPathSetting (memdir/paths.ts:161-186): a full-path
 * `autoMemoryDirectory` override, read ONLY from trusted settings layers —
 * the project-committed `.claude/settings.json` is intentionally excluded
 * (a malicious repo must not redirect memory writes into `~/.ssh` etc.).
 * omp has no policy/flag layer, so: project `settings.local.json` wins over
 * user `<configDir>/settings.json`, matching CC's local>user precedence.
 * CC's CLAUDE_COWORK_MEMORY_PATH_OVERRIDE (hosted-Cowork only) is not ported.
 */
async function getAutoMemPathOverride(projectDir: string, claudeConfigDir: string): Promise<string | undefined> {
	const local = await readClaudeSettingsFile(path.join(projectDir, ".claude", "settings.local.json"));
	const localValue =
		typeof local?.autoMemoryDirectory === "string" ? validateMemoryPath(local.autoMemoryDirectory, true) : undefined;
	if (localValue) return localValue;
	const user = await readClaudeSettingsFile(path.join(claudeConfigDir, "settings.json"));
	if (typeof user?.autoMemoryDirectory === "string") {
		return validateMemoryPath(user.autoMemoryDirectory, true);
	}
	return undefined;
}

/** Port of CC getMemoryBaseDir (memdir/paths.ts:85-91): CLAUDE_CODE_REMOTE_MEMORY_DIR wins over the config home. */
function claudeMemoryBaseDir(claudeConfigDir: string): string {
	return process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR || claudeConfigDir;
}

/** CC's checked-in project memory dir: `<project>/.claude/memory`. */
export function ccLocalMemoryDir(projectDir: string): string {
	return path.join(projectDir, ".claude", "memory");
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await stat(target);
		return true;
	} catch {
		return false;
	}
}

export interface ListMemorySourcesOptions {
	agentDir: string;
	projectDir: string;
	shared: ClaudeSharedMode;
	/** Override for `CLAUDE_CONFIG_DIR` resolution (tests). */
	claudeConfigDir?: string;
	/** Existence probe override (tests). Never creates directories. */
	exists?: (target: string) => Promise<boolean>;
}

/**
 * Resolve the active memory sources, ordered `[omp, cc-local?, cc-project?]`.
 *
 * - `off`: omp only — behavior identical to a machine without Claude Code.
 * - `auto`: the Claude project source joins when its memory dir exists OR
 *   the Claude config dir exists (CC installed here is the adoption signal).
 * - `on`: the Claude project source always joins (created on first write).
 */
export async function listMemorySources(options: ListMemorySourcesOptions): Promise<MemorySource[]> {
	const exists = options.exists ?? pathExists;
	const omp: MemorySource = { dir: claudemdMemoryDir(options.agentDir), kind: "omp", writable: true };
	if (options.shared === "off") return [omp];

	const sources: MemorySource[] = [omp];
	const ccLocal = ccLocalMemoryDir(options.projectDir);
	if (await exists(ccLocal)) sources.push({ dir: ccLocal, kind: "cc-local", writable: false });

	const configDir = options.claudeConfigDir ?? resolveClaudePaths().configDir;
	// CC keys the project memory dir by the canonical git root (worktrees and
	// subdirectories share one memory), and honours the trusted-source override
	// chain before falling back to `<base>/projects/<escaped>/memory`.
	const memoryKey = await ccMemoryKey(options.projectDir);
	const ccDir =
		(await getAutoMemPathOverride(options.projectDir, configDir)) ??
		ccProjectMemoryDir(memoryKey, claudeMemoryBaseDir(configDir));
	const ccApplies = options.shared === "on" || (await exists(ccDir)) || (await exists(configDir));
	if (ccApplies) sources.push({ dir: ccDir, kind: "cc-project", writable: true });
	return sources;
}

/**
 * Write target for every omp-originated write (save, extraction, dream):
 * the CC project dir when shared interop is active — CC reads and writes the
 * same copy — otherwise the omp dir.
 */
export function resolveWriteTarget(sources: readonly MemorySource[]): string {
	const cc = sources.find(s => s.kind === "cc-project" && s.writable);
	if (cc) return cc.dir;
	const omp = sources.find(s => s.kind === "omp");
	if (!omp) throw new Error("claudemd: no writable memory source");
	return omp.dir;
}
