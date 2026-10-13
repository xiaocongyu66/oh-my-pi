/**
 * Cross-process training lock, ported from memory/claudemd-backend/dream.ts
 * (same PID+mtime+re-read-verify semantics): a `<slug>.lock` file in the
 * skill's evolution dir holds the holder's PID; a fresh mtime with a live PID
 * blocks, a dead PID or stale mtime is reclaimed, and last-writer-wins losers
 * bail on re-read. Shared by manual `/evolve train` and the nightly tick, so
 * concurrent campaigns for one slug serialize instead of corrupting state.
 */
import { mkdir, readFile, stat, unlink, utimes, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { getSkillEvolutionDir } from "./storage";

export const EVOLUTION_HOLDER_STALE_MS = 60 * 60 * 1000;

export function evolutionLockPath(slug: string, agentDir: string): string {
	return path.join(getSkillEvolutionDir(slug, agentDir), "training.lock");
}

/** True when `pid` refers to a live process (ESRCH test; EPERM = alive). */
export function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Acquire the training lock for `slug`. Returns the pre-acquire mtime
 * (for rollback), or null when another live holder owns it / a race was lost.
 */
export async function tryAcquireEvolutionLock(slug: string, agentDir: string): Promise<number | null> {
	const lockPath = evolutionLockPath(slug, agentDir);

	let mtimeMs: number | undefined;
	let holderPid: number | undefined;
	try {
		const [s, raw] = await Promise.all([stat(lockPath), readFile(lockPath, "utf8")]);
		mtimeMs = s.mtimeMs;
		const parsed = parseInt(raw.trim(), 10);
		holderPid = Number.isFinite(parsed) ? parsed : undefined;
	} catch {
		// ENOENT — no prior lock.
	}

	if (mtimeMs !== undefined && Date.now() - mtimeMs < EVOLUTION_HOLDER_STALE_MS) {
		if (holderPid !== undefined && isProcessRunning(holderPid)) {
			return null;
		}
		// Dead PID or unparseable body — reclaim.
	}

	await mkdir(path.dirname(lockPath), { recursive: true });
	await writeFile(lockPath, String(process.pid));

	// Two reclaimers both write → last wins. Loser bails on re-read.
	let verify: string;
	try {
		verify = await readFile(lockPath, "utf8");
	} catch {
		return null;
	}
	if (parseInt(verify.trim(), 10) !== process.pid) return null;

	return mtimeMs ?? 0;
}

/**
 * Release after a successful run: prior=0 (no lock existed) removes the file;
 * otherwise clear the PID body so a crash-recovery reclaim reads unparseable,
 * and rewind mtime to the pre-run value so lastRunDate-style reads stay true.
 */
export async function rollbackEvolutionLock(slug: string, agentDir: string, priorMtime: number): Promise<void> {
	const lockPath = evolutionLockPath(slug, agentDir);
	if (priorMtime === 0) {
		try {
			await unlink(lockPath);
		} catch {
			// Already gone.
		}
		return;
	}
	try {
		await writeFile(lockPath, "");
		const rewind = new Date(priorMtime);
		await utimes(lockPath, rewind, rewind);
	} catch {
		// Best-effort rollback; a stuck lock reclaims after the stale window.
	}
}
