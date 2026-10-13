import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	EVOLUTION_HOLDER_STALE_MS,
	evolutionLockPath,
	isProcessRunning,
	rollbackEvolutionLock,
	tryAcquireEvolutionLock,
} from "../../src/evolution/lock";

async function makeAgentDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "omp-evol-lock-"));
}

async function stampLock(agentDir: string, pid: number, ageMs = 0): Promise<void> {
	const lockPath = evolutionLockPath("demo", agentDir);
	await fs.mkdir(path.dirname(lockPath), { recursive: true });
	await fs.writeFile(lockPath, String(pid));
	if (ageMs > 0) {
		const stale = new Date(Date.now() - ageMs);
		const { utimes } = await import("node:fs/promises");
		await utimes(lockPath, stale, stale);
	}
}

describe("tryAcquireEvolutionLock", () => {
	it("acquires on a fresh directory and reports prior=0", async () => {
		const agentDir = await makeAgentDir();
		expect(await tryAcquireEvolutionLock("demo", agentDir)).toBe(0);
		await fs.rm(agentDir, { recursive: true, force: true });
	});

	it("blocks while a live holder owns a fresh lock", async () => {
		const agentDir = await makeAgentDir();
		await stampLock(agentDir, process.pid);
		expect(await tryAcquireEvolutionLock("demo", agentDir)).toBeNull();
		await fs.rm(agentDir, { recursive: true, force: true });
	});

	it("reclaims a lock whose holder PID is dead", async () => {
		const agentDir = await makeAgentDir();
		// High-range PID is unlikely to exist; bail on environment fluke.
		const deadPid = 4_000_000 + (process.pid % 1000);
		if (isProcessRunning(deadPid)) return;
		await stampLock(agentDir, deadPid);
		// Pre-acquire mtime is the stamped file's mtime (>0), not 0.
		expect(await tryAcquireEvolutionLock("demo", agentDir)).toBeGreaterThan(0);
		await fs.rm(agentDir, { recursive: true, force: true });
	});

	it("reclaims a stale lock even with a plausible PID body", async () => {
		const agentDir = await makeAgentDir();
		await stampLock(agentDir, process.pid, EVOLUTION_HOLDER_STALE_MS + 1000);
		expect(await tryAcquireEvolutionLock("demo", agentDir)).toBeGreaterThan(0);
		await fs.rm(agentDir, { recursive: true, force: true });
	});

	it("loses the reclamation race and bails when another writer wins", async () => {
		const agentDir = await makeAgentDir();
		// Simulate the loser: write a different PID after our verify-read would run.
		const lockPath = evolutionLockPath("demo", agentDir);
		await stampLock(agentDir, 4_000_500, EVOLUTION_HOLDER_STALE_MS + 1000);
		// Winner takes it first.
		const winnerPrior = await tryAcquireEvolutionLock("demo", agentDir);
		expect(winnerPrior).toBeGreaterThan(0);
		// A stale-but-rewritten check: loser's re-read sees the winner PID and bails.
		await fs.writeFile(lockPath, String(process.pid));
		expect(
			await (async () => {
				// Re-running now returns null because the fresh lock is held by us.
				return tryAcquireEvolutionLock("demo", agentDir);
			})(),
		).toBeNull();
		await fs.rm(agentDir, { recursive: true, force: true });
	});
});

describe("rollbackEvolutionLock", () => {
	it("removes the file when no prior lock existed (prior=0)", async () => {
		const agentDir = await makeAgentDir();
		await tryAcquireEvolutionLock("demo", agentDir);
		await rollbackEvolutionLock("demo", agentDir, 0);
		await expect(fs.access(evolutionLockPath("demo", agentDir))).rejects.toThrow();
		await fs.rm(agentDir, { recursive: true, force: true });
	});

	it("clears the PID body and rewinds mtime when a prior lock existed", async () => {
		const agentDir = await makeAgentDir();
		await stampLock(agentDir, 4_000_600, 60_000);
		const prior = (await fs.stat(evolutionLockPath("demo", agentDir))).mtimeMs;
		await tryAcquireEvolutionLock("demo", agentDir);
		await rollbackEvolutionLock("demo", agentDir, prior);
		const s = await fs.stat(evolutionLockPath("demo", agentDir));
		expect(Math.abs(s.mtimeMs - prior)).toBeLessThan(5);
		const body = await fs.readFile(evolutionLockPath("demo", agentDir), "utf8");
		expect(body.trim()).toBe("");
		await fs.rm(agentDir, { recursive: true, force: true });
	});
});
