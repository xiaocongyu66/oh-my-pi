/**
 * Memory source resolution for Claude-Code-directory interop.
 *
 * Three source kinds feed the claudemd backend:
 * - `omp`: `${agentDir}/memory/` — always present, writable only when no
 *   Claude project directory is active (it is the default write target and
 *   the only directory `clear()` may delete).
 * - `cc-project`: `${claudeConfigDir}/projects/<escaped cwd>/memory/` —
 *   Claude Code's per-project memory directory. When active it is the write
 *   target (CC reads/writes the same files, zero format migration).
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

import { stat } from "node:fs/promises";
import * as path from "node:path";
import { resolveClaudePaths } from "../../config/claude-paths";
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

/** CC's per-project memory dir: `<configDir>/projects/<escaped>/memory`. */
export function ccProjectMemoryDir(projectDir: string, claudeConfigDir?: string): string {
	const configDir = claudeConfigDir ?? resolveClaudePaths().configDir;
	return path.join(configDir, "projects", escapeClaudeProjectPath(projectDir), "memory");
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
	const ccDir = ccProjectMemoryDir(options.projectDir, configDir);
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
