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
import { copyFile, mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
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

/**
 * Copy a directory tree by value, skipping symlinks entirely and pruning
 * SKIP_NAMES. Symlinks MUST NOT be copied: node's fs.cp replicates them
 * verbatim, and workspace node_modules links routinely point outside the
 * repo (pnpm store, global prefixes) — a verbatim link would let the
 * sandboxed session read AND write real files outside the sandbox.
 */
const SKIP_NAMES = new Set([".git"]);

async function copyTree(src: string, dest: string, budget: { remaining: number }): Promise<void> {
	await mkdir(dest, { recursive: true });
	let entries;
	try {
		entries = await readdir(src, { withFileTypes: true });
	} catch (error) {
		// A vanished source directory mid-walk is benign; other errors surface.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	for (const entry of entries) {
		if (SKIP_NAMES.has(entry.name)) continue;
		// Never follow or replicate links: no escape hatches, no cycles.
		if (entry.isSymbolicLink()) continue;
		const from = path.join(src, entry.name);
		const to = path.join(dest, entry.name);
		if (entry.isDirectory()) {
			await copyTree(from, to, budget);
			continue;
		}
		const info = await stat(from);
		budget.remaining -= info.size;
		if (budget.remaining < 0) {
			throw new Error(`project tree too large to sandbox (budget exceeded in ${from})`);
		}
		// copyFile preserves mode, so executable scripts keep working in the copy.
		await copyFile(from, to);
	}
}

/** Build the sandbox. Throws on any failure — callers treat that as fail-closed. */
export async function assembleSandbox(opts: SandboxOptions): Promise<SandboxPaths> {
	const root = await mkdtemp(path.join(os.tmpdir(), "omp-evol-l2-"));
	const workdir = path.join(root, "work");
	const agentDir = path.join(root, "agentdir");
	try {
		await copyTree(opts.projectDir, workdir, { remaining: opts.maxCopyBytes ?? DEFAULT_MAX_COPY_BYTES });

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
