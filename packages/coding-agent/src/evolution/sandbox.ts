/**
 * L2 verification sandbox: the headless `omp -p` session must never run with
 * full permissions inside the user's real project — harvested task prompts are
 * replayed verbatim, and a destructive task in history would execute for real.
 *
 * The sandbox is deliberately loosely coupled (user requirement): evolution
 * writes files and env, and never imports security/session internals. The
 * spawned omp assembles its own safety posture from the sandbox config.yml:
 *
 *   permissions.defaultMode: auto   → engine rules + asks resolved by the
 *                                     auto-mode safety classifier (model
 *                                     review of the exact content to run);
 *                                     undecidable asks deny (fail-closed).
 *   modelRoles.advisor: <model>     → the dedicated approval model the
 *                                     classifier resolves through.
 *   managed-skills/<slug>/SKILL.md  → the candidate skill, so the session
 *                                     actually verifies the trained artifact.
 */
import { cp, mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { sanitizeSkillName } from "../autolearn/managed-skills";

const DEFAULT_MAX_COPY_BYTES = 2 * 1024 * 1024 * 1024;

export interface SandboxPaths {
	/** tmp root holding everything; removal target. */
	root: string;
	/** Project copy the headless session runs in. */
	workdir: string;
	/** Redirected agent dir (candidate skill + sandbox config.yml). */
	agentDir: string;
}

export interface SandboxOptions {
	projectDir: string;
	slug: string;
	skillContent?: string;
	approvalModel: string;
	maxCopyBytes?: number;
}

/** Size of a tree, following the same skip rules as the copy below. */
async function treeSize(dir: string, skipNames: Set<string>): Promise<number> {
	let total = 0;
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		if (skipNames.has(entry.name)) continue;
		const full = path.join(dir, entry.name);
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) {
			total += await treeSize(full, skipNames);
		} else {
			try {
				total += (await stat(full)).size;
			} catch {
				// Vanished mid-walk; ignore.
			}
		}
	}
	return total;
}

/**
 * Build the sandbox. Throws on any failure — callers treat that as
 * fail-closed and record hard=0 samples instead of running unsandboxed.
 */
export async function assembleSandbox(opts: SandboxOptions): Promise<SandboxPaths> {
	const root = await mkdtemp(path.join(os.tmpdir(), "omp-evol-l2-"));
	const workdir = path.join(root, "work");
	const agentDir = path.join(root, "agentdir");
	try {
		// Copy budget check first so an oversized repo fails fast, before
		// burning time on a doomed copy.
		const maxBytes = opts.maxCopyBytes ?? DEFAULT_MAX_COPY_BYTES;
		const size = await treeSize(opts.projectDir, new Set([".git"]));
		if (size > maxBytes) {
			throw new Error(`project tree too large to sandbox (${size} bytes > ${maxBytes})`);
		}
		// fs.cp skips symlinks (no dereference → no escape/cycles) and we
		// pre-walked with the same skip set, but cp itself cannot skip .git,
		// so copy everything and prune the one directory we never want.
		await cp(opts.projectDir, workdir, { recursive: true });
		await rm(path.join(workdir, ".git"), { recursive: true, force: true });

		if (opts.skillContent) {
			const skillDir = path.join(agentDir, "managed-skills", sanitizeSkillName(opts.slug));
			await mkdir(skillDir, { recursive: true });
			await writeFile(path.join(skillDir, "SKILL.md"), opts.skillContent, "utf8");
		}

		const advisor = opts.approvalModel.trim();
		const configYaml = [
			"permissions:",
			"  defaultMode: auto",
			...(advisor ? ["modelRoles:", `  advisor: ${JSON.stringify(advisor)}`] : []),
			"",
		].join("\n");
		await mkdir(agentDir, { recursive: true });
		await writeFile(path.join(agentDir, "config.yml"), configYaml, "utf8");

		return { root, workdir, agentDir };
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error instanceof Error ? error : new Error(String(error));
	}
}

/** Remove the whole sandbox tree. Best-effort; safe to call twice. */
export async function cleanupSandbox(sb: SandboxPaths): Promise<void> {
	await rm(sb.root, { recursive: true, force: true });
}
