import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createClaudeMdBackend, releaseClaudeMdSession } from "../../src/memory/claudemd-backend/backend";
import {
	consolidationLockPath,
	rollbackConsolidationLock,
	tryAcquireConsolidationLock,
	readLastConsolidatedAt,
	HOLDER_STALE_MS,
} from "../../src/memory/claudemd-backend/dream";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSession } from "../../src/session/agent-session";
import type { MemoryBackendStartOptions } from "../../src/memory-backend/types";

let tempDir: string | undefined;

async function makeTempDir(): Promise<string> {
	tempDir = await mkdtemp(path.join(os.tmpdir(), "claudemd-backend-"));
	return tempDir;
}

afterEach(async () => {
	if (tempDir) {
		await rm(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

// ============================================================================
// Harness
// ============================================================================

interface FakeSessionOptions {
	agentDir: string;
	complete?: (system: string, user: string) => Promise<string>;
}

function fakeSession(options: FakeSessionOptions): {
	session: AgentSession;
	listeners: ((event: { type: string }) => void)[];
} {
	const listeners: ((event: { type: string }) => void)[] = [];
	const session = {
		sessionId: "test-session",
		messages: [] as AgentMessage[],
		settings: { getAgentDir: () => options.agentDir },
		subscribe: (listener: (event: { type: string }) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index !== -1) listeners.splice(index, 1);
			};
		},
	} as unknown as AgentSession;
	return { session, listeners };
}

function setMessages(session: AgentSession, messages: AgentMessage[]): void {
	(session as unknown as { messages: AgentMessage[] }).messages = messages;
}

function startBackend(
	agentDir: string,
	session: AgentSession,
	complete?: (system: string, user: string) => Promise<string>,
): void {
	const backend = createClaudeMdBackend({ complete });
	const startOptions: MemoryBackendStartOptions = {
		session,
		settings: session.settings,
		modelRegistry: {} as MemoryBackendStartOptions["modelRegistry"],
		agentDir,
		taskDepth: 0,
	};
	backend.start(startOptions);
}

/** Assistant/user message factory (only role + content matter to the backend). */
function msg(role: "user" | "assistant", text: string): AgentMessage {
	return { role, content: text, timestamp: Date.now() } as unknown as AgentMessage;
}

const NO_MEMORY_JSON = '{"files": [], "index_lines": []}';

/** Poll until `condition()` holds (awaited); gives up after `timeoutMs`. */
async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	for (;;) {
		if (await condition()) return;
		if (Date.now() - start > timeoutMs) return;
		await Bun.sleep(5);
	}
}

// ============================================================================
// buildDeveloperInstructions
// ============================================================================

describe("claudemd buildDeveloperInstructions", () => {
	it("returns the full instruction block and creates the memory dir", async () => {
		const agentDir = await makeTempDir();
		const backend = createClaudeMdBackend({ complete: async () => NO_MEMORY_JSON });
		const instructions = await backend.buildDeveloperInstructions(agentDir, {} as never);
		expect(instructions).toBeDefined();
		expect(instructions).toContain("# auto memory");
		expect(instructions).toContain(path.join(agentDir, "memory"));
		expect(instructions).toContain("Your MEMORY.md is currently empty.");
		await expect(stat(path.join(agentDir, "memory"))).resolves.toBeDefined();
	});

	it("includes existing MEMORY.md content", async () => {
		const agentDir = await makeTempDir();
		const memoryDir = path.join(agentDir, "memory");
		await mkdir(memoryDir, { recursive: true });
		await writeFile(path.join(memoryDir, "MEMORY.md"), "- [Existing](existing.md) — hook\n", "utf8");
		const backend = createClaudeMdBackend({ complete: async () => NO_MEMORY_JSON });
		const instructions = await backend.buildDeveloperInstructions(agentDir, {} as never);
		expect(instructions).toContain("- [Existing](existing.md) — hook");
		expect(instructions).not.toContain("currently empty");
	});
});

// ============================================================================
// save() round-trip
// ============================================================================

describe("claudemd save", () => {
	it("writes a topic file with frontmatter and appends an index line", async () => {
		const agentDir = await makeTempDir();
		const backend = createClaudeMdBackend({ complete: async () => NO_MEMORY_JSON });
		const result = await backend.save!(
			{ agentDir, cwd: agentDir },
			{ content: "Deploy checklist lives in runbook/", context: "Deploy runbook pointer" },
		);
		expect(result.stored).toBe(1);
		expect(result.ids).toHaveLength(1);
		const filename = result.ids![0]!;
		expect(filename.endsWith(".md")).toBe(true);
		expect(filename).not.toBe("MEMORY.md");

		const content = await readFile(path.join(agentDir, "memory", filename), "utf8");
		expect(content).toContain("---");
		expect(content).toContain("type: project");
		expect(content).toContain("Deploy checklist lives in runbook/");

		const index = await readFile(path.join(agentDir, "memory", "MEMORY.md"), "utf8");
		expect(index).toContain(`- [Deploy checklist lives in runbook/](${filename}) — Deploy runbook pointer`);
	});

	it("honors a `Type: user` content prefix and slugifies the name", async () => {
		const agentDir = await makeTempDir();
		const backend = createClaudeMdBackend({ complete: async () => NO_MEMORY_JSON });
		const result = await backend.save!({ agentDir, cwd: agentDir }, { content: "user: Prefers bun over npm" });
		const filename = result.ids![0]!;
		expect(filename).toBe("prefers_bun_over_npm.md");
		const content = await readFile(path.join(agentDir, "memory", filename), "utf8");
		expect(content).toContain("type: user");
	});

	it("uniquifies colliding filenames", async () => {
		const agentDir = await makeTempDir();
		const backend = createClaudeMdBackend({ complete: async () => NO_MEMORY_JSON });
		await backend.save!({ agentDir, cwd: agentDir }, { content: "Same title here" });
		const second = await backend.save!({ agentDir, cwd: agentDir }, { content: "Same title here" });
		expect(second.ids![0]).toBe("same_title_here-2.md");
	});

	it("rejects empty content", async () => {
		const agentDir = await makeTempDir();
		const backend = createClaudeMdBackend({ complete: async () => NO_MEMORY_JSON });
		const result = await backend.save!({ agentDir, cwd: agentDir }, { content: "   " });
		expect(result.stored).toBe(0);
	});
});

// ============================================================================
// Extraction (turn-end)
// ============================================================================

describe("claudemd extraction", () => {
	it("writes files and appends index lines from the fake LLM response", async () => {
		const agentDir = await makeTempDir();
		const memoryDir = path.join(agentDir, "memory");
		const { session, listeners } = fakeSession({ agentDir });
		let extractionSystem = "";
		let extractionUser = "";
		let calls = 0;
		startBackend(agentDir, session, async (system, user) => {
			calls += 1;
			extractionSystem = system;
			extractionUser = user;
			return JSON.stringify({
				files: [
					{
						filename: "project_deploy.md",
						content:
							"---\nname: deploy\ndescription: Deploy flow\ntype: project\n---\n\nDeploys ship on Tuesdays.",
					},
				],
				index_lines: ["- [Deploy flow](project_deploy.md) — how deploys work"],
			});
		});

		setMessages(session, [msg("user", "How do deploys work around here?")]);
		expect(listeners).toHaveLength(1);
		listeners[0]!({ type: "turn_end" });
		// Fire-and-forget — wait for the LLM call + writes.
		await waitFor(() => calls === 1);
		await waitFor(async () => {
			try {
				await readFile(path.join(memoryDir, "MEMORY.md"), "utf8");
				return true;
			} catch {
				return false;
			}
		});

		expect(calls).toBe(1);
		expect(extractionSystem).toContain("memory extraction subagent");
		expect(extractionSystem).toContain("## Types of memory");
		expect(extractionSystem).toContain("## What NOT to save in memory");
		expect(extractionSystem).toContain("## How to save memories");
		expect(extractionUser).toContain("user: How do deploys work around here?");

		const written = await readFile(path.join(memoryDir, "project_deploy.md"), "utf8");
		expect(written).toContain("Deploys ship on Tuesdays.");
		const index = await readFile(path.join(memoryDir, "MEMORY.md"), "utf8");
		expect(index).toContain("- [Deploy flow](project_deploy.md) — how deploys work");
	});

	it("rejects bad filenames, non-md files, and insane frontmatter types", async () => {
		const agentDir = await makeTempDir();
		const memoryDir = path.join(agentDir, "memory");
		const { session, listeners } = fakeSession({ agentDir });
		startBackend(agentDir, session, async () =>
			JSON.stringify({
				files: [
					{ filename: "MEMORY.md", content: "---\ntype: user\n---\nhijack" },
					{ filename: "../escape.md", content: "---\ntype: user\n---\nescape" },
					{ filename: "plain.txt", content: "not markdown" },
					{ filename: "bad_type.md", content: "---\ntype: secret\n---\ninvalid type" },
					{ filename: "valid.md", content: "---\ntype: feedback\n---\nGood memory." },
					{ filename: "empty.md", content: "   " },
				],
				index_lines: ["- [Valid](valid.md) — kept"],
			}),
		);

		setMessages(session, [msg("user", "one two three")]);
		listeners[0]!({ type: "turn_end" });
		// Wait on MEMORY.md, not valid.md: extraction writes topic files before
		// the index, so a valid.md sighting still leaves the index write in flight.
		await waitFor(async () => {
			try {
				return (await readFile(path.join(memoryDir, "MEMORY.md"), "utf8")).includes("valid.md");
			} catch {
				return false;
			}
		});

		// Only the valid file survives; nothing escaped the memory dir.
		const entries = await readdir(memoryDir);
		expect(entries.sort()).toEqual(["MEMORY.md", "valid.md"]);
		const valid = await readFile(path.join(memoryDir, "valid.md"), "utf8");
		expect(valid).toContain("Good memory.");
		const index = await readFile(path.join(memoryDir, "MEMORY.md"), "utf8");
		expect(index).toContain("- [Valid](valid.md) — kept");
		expect(index).not.toContain("hijack");
		await expect(stat(path.join(agentDir, "escape.md"))).rejects.toThrow();
	});

	it("mutual exclusion: a turn ending mid-extraction stashes exactly one trailing run", async () => {
		const agentDir = await makeTempDir();
		const { session, listeners } = fakeSession({ agentDir });
		let resolveFirst: ((value: string) => void) | undefined;
		const firstCall = new Promise<string>(resolve => {
			resolveFirst = resolve;
		});
		let calls = 0;
		startBackend(agentDir, session, async () => {
			calls += 1;
			if (calls === 1) {
				// Hold the first extraction open until the test signals.
				return await firstCall;
			}
			return NO_MEMORY_JSON;
		});

		setMessages(session, [msg("user", "first turn prompt words")]);
		listeners[0]!({ type: "turn_end" });
		await waitFor(() => calls === 1);
		// Second turn_end while the first extraction is still pending.
		setMessages(session, [
			msg("user", "first turn prompt words"),
			msg("assistant", "answer"),
			msg("user", "second turn prompt words"),
		]);
		listeners[0]!({ type: "turn_end" });
		await Bun.sleep(20);
		expect(calls).toBe(1); // second turn stashed, not run

		resolveFirst!(NO_MEMORY_JSON);
		await waitFor(() => calls === 2);
		// Trailing run fired exactly once after the first completed.
		expect(calls).toBe(2);
	});

	it("advances the cursor only on success and resets on compaction shrinkage", async () => {
		const agentDir = await makeTempDir();
		const { session, listeners } = fakeSession({ agentDir });
		let calls = 0;
		startBackend(agentDir, session, async () => {
			calls += 1;
			if (calls === 1) throw new Error("LLM transient failure");
			return NO_MEMORY_JSON;
		});

		setMessages(session, [msg("user", "some prompt with words"), msg("assistant", "an answer")]);
		listeners[0]!({ type: "turn_end" });
		await waitFor(() => calls === 1);
		expect(calls).toBe(1);

		// Same-length transcript again: cursor did NOT advance after failure,
		// so the same messages are reconsidered.
		listeners[0]!({ type: "turn_end" });
		await waitFor(() => calls === 2);
		expect(calls).toBe(2);

		// Success advanced the cursor to the current watermark: an identical
		// transcript re-extracts nothing.
		listeners[0]!({ type: "turn_end" });
		await Bun.sleep(50);
		expect(calls).toBe(2);

		// Compaction shrinkage (2 messages → 1) resets the watermark → count
		// ALL messages again, so extraction is never permanently disabled.
		setMessages(session, [msg("user", "compacted summary words")]);
		listeners[0]!({ type: "turn_end" });
		await waitFor(() => calls === 3);
		expect(calls).toBe(3);
	});

	it("does not start on subagent sessions (taskDepth > 0)", async () => {
		const agentDir = await makeTempDir();
		const { session, listeners } = fakeSession({ agentDir });
		const backend = createClaudeMdBackend({ complete: async () => NO_MEMORY_JSON });
		backend.start({
			session,
			settings: session.settings,
			modelRegistry: {} as never,
			agentDir,
			taskDepth: 1,
		});
		expect(listeners).toHaveLength(0);
	});
});

// ============================================================================
// Dream lock (ported semantics)
// ============================================================================

describe("claudemd dream lock", () => {
	it("acquires cleanly, records lastConsolidatedAt as mtime, and exposes the PID body", async () => {
		const dir = await makeTempDir();
		const prior = await tryAcquireConsolidationLock(dir);
		expect(prior).toBe(0);
		const lockPath = consolidationLockPath(dir);
		const body = await readFile(lockPath, "utf8");
		expect(body).toBe(String(process.pid));
		const lastAt = await readLastConsolidatedAt(dir);
		expect(Math.abs(Date.now() - lastAt)).toBeLessThan(5000);
	});

	it("blocks a second acquire while a live PID holds a fresh lock", async () => {
		const dir = await makeTempDir();
		expect(await tryAcquireConsolidationLock(dir)).toBe(0);
		expect(await tryAcquireConsolidationLock(dir)).toBeNull();
	});

	it("reclaims a stale lock whose PID is dead (0x7FFFFFFF)", async () => {
		const dir = await makeTempDir();
		await mkdir(dir, { recursive: true });
		const lockPath = consolidationLockPath(dir);
		const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
		await writeFile(lockPath, String(0x7fffffff), "utf8");
		await utimes(lockPath, staleTime, staleTime);
		// Fresh mtime but dead PID → still reclaimable.
		expect(await tryAcquireConsolidationLock(dir)).toBe(staleTime.getTime());
		expect(await readFile(lockPath, "utf8")).toBe(String(process.pid));
	});

	it("blocks a live-PID holder only until the stale window passes", async () => {
		const dir = await makeTempDir();
		const lockPath = consolidationLockPath(dir);
		await writeFile(lockPath, String(process.pid), "utf8");
		const stale = new Date(Date.now() - HOLDER_STALE_MS - 1000);
		await utimes(lockPath, stale, stale);
		// Stale window passed even though the PID is live → reclaim.
		expect(await tryAcquireConsolidationLock(dir)).not.toBeNull();
	});

	it("rollback with priorMtime 0 unlinks the lock", async () => {
		const dir = await makeTempDir();
		await tryAcquireConsolidationLock(dir);
		await rollbackConsolidationLock(dir, 0);
		await expect(stat(consolidationLockPath(dir))).rejects.toThrow();
	});

	it("rollback with a prior mtime clears the body and restores the mtime", async () => {
		const dir = await makeTempDir();
		await mkdir(dir, { recursive: true });
		const lockPath = consolidationLockPath(dir);
		const priorTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
		await writeFile(lockPath, "12345", "utf8");
		await utimes(lockPath, priorTime, priorTime);

		const acquired = await tryAcquireConsolidationLock(dir);
		expect(acquired).toBe(priorTime.getTime());
		expect(await readFile(lockPath, "utf8")).toBe(String(process.pid));

		await rollbackConsolidationLock(dir, acquired!);
		expect(await readFile(lockPath, "utf8")).toBe("");
		const restored = await stat(lockPath);
		expect(Math.abs(restored.mtimeMs - priorTime.getTime())).toBeLessThan(1100);
	});
});

// ============================================================================
// Dream end-to-end (fake LLM)
// ============================================================================

describe("claudemd dream consolidation", () => {
	it("writes merged files, removes stale files and their index pointers, stamps the lock", async () => {
		const agentDir = await makeTempDir();
		const memoryDir = path.join(agentDir, "memory");
		await mkdir(memoryDir, { recursive: true });
		await writeFile(
			path.join(memoryDir, "MEMORY.md"),
			"- [Stale topic](stale_topic.md) — outdated\n- [Keep](keep.md) — still good\n",
			"utf8",
		);
		await writeFile(path.join(memoryDir, "stale_topic.md"), "---\ntype: project\n---\nold facts", "utf8");
		await writeFile(path.join(memoryDir, "keep.md"), "---\ntype: project\n---\nkeep content", "utf8");

		const { session, listeners } = fakeSession({ agentDir });
		let dreamSystem = "";
		// Enqueue is the manual /dream path (no time/session gates); the
		// consolidation prompt (with memory payloads) travels as the system arg.
		const backend = createClaudeMdBackend({
			complete: async (system, _user) => {
				dreamSystem = system;
				return JSON.stringify({
					files: [{ filename: "merged.md", content: "---\ntype: project\n---\nmerged content" }],
					index_lines: ["- [Merged](merged.md) — new pointer"],
					remove: ["stale_topic.md"],
					summary: "Merged stale topic.",
				});
			},
		});
		backend.start({
			session,
			settings: session.settings,
			modelRegistry: {} as never,
			agentDir,
			taskDepth: 0,
		});
		await backend.enqueue(agentDir, agentDir, session);
		expect(dreamSystem).toContain("# Dream: Memory Consolidation");
		expect(dreamSystem).toContain("## Phase 3 — Consolidate");
		expect(dreamSystem).toContain("## Phase 4 — Prune and index");
		expect(dreamSystem).toContain("keep content");
		expect(dreamSystem).toContain("stale_topic.md");

		const entries = (await readdir(memoryDir)).sort();
		expect(entries).toContain("merged.md");
		expect(entries).not.toContain("stale_topic.md");
		const index = await readFile(path.join(memoryDir, "MEMORY.md"), "utf8");
		expect(index).not.toContain("stale_topic.md");
		expect(index).toContain("- [Keep](keep.md) — still good");
		expect(index).toContain("- [Merged](merged.md) — new pointer");
		// Lock stamped on success.
		const lastAt = await readLastConsolidatedAt(memoryDir);
		expect(Math.abs(Date.now() - lastAt)).toBeLessThan(5000);
	});

	it("rolls the lock back when the dream LLM call fails, reopening the time gate", async () => {
		const agentDir = await makeTempDir();
		const memoryDir = path.join(agentDir, "memory");
		await mkdir(memoryDir, { recursive: true });
		const backend = createClaudeMdBackend({
			complete: async () => {
				throw new Error("LLM down");
			},
		});
		await expect(backend.enqueue(agentDir, agentDir)).rejects.toThrow("LLM down");
		// Lock rolled back → lastConsolidatedAt reads 0 (file gone).
		expect(await readLastConsolidatedAt(memoryDir)).toBe(0);
	});

	it("auto-dream respects the 24h and 5-session gates (no LLM call when gated)", async () => {
		const agentDir = await makeTempDir();
		const memoryDir = path.join(agentDir, "memory");
		await mkdir(memoryDir, { recursive: true });
		const { session, listeners } = fakeSession({ agentDir });
		let calls = 0;
		startBackend(agentDir, session, async () => {
			calls += 1;
			return NO_MEMORY_JSON;
		});

		// Extraction turn: no lock file → hoursSince is huge, but zero sessions
		// touched since 0... sessions dir missing → 0 < 5 → gated off.
		setMessages(session, [msg("user", "a prompt with words")]);
		listeners[0]!({ type: "turn_end" });
		await waitFor(() => calls === 1);
		await Bun.sleep(50);
		// Only the extraction call happened, never a dream call.
		expect(calls).toBe(1);
		expect(await readLastConsolidatedAt(memoryDir)).toBe(0);
	});
});

// ============================================================================
// Recall wiring through beforeAgentStartPrompt
// ============================================================================

describe("claudemd beforeAgentStartPrompt", () => {
	it("surfaces selected memories and commit() marks them surfaced against the budget", async () => {
		const agentDir = await makeTempDir();
		const memoryDir = path.join(agentDir, "memory");
		await mkdir(memoryDir, { recursive: true });
		await writeFile(
			path.join(memoryDir, "topic.md"),
			"---\nname: topic\ndescription: About deploy flows\ntype: project\n---\n\ndeploy body",
			"utf8",
		);
		const { session } = fakeSession({ agentDir });
		let selectorCalls = 0;
		const backend = createClaudeMdBackend({
			complete: async system => {
				if (system.startsWith("You are selecting memories")) {
					selectorCalls += 1;
					return '{"selected_memories": ["topic.md"]}';
				}
				return NO_MEMORY_JSON;
			},
		});
		backend.start({
			session,
			settings: session.settings,
			modelRegistry: {} as never,
			agentDir,
			taskDepth: 0,
		});

		const preparation = await backend.beforeAgentStartPrompt!(session, "how do the deploy flows work here?");
		expect(preparation).toBeDefined();
		expect(preparation!.context).toContain("deploy body");
		expect(preparation!.context).toContain("<system-reminder>");
		expect(selectorCalls).toBe(1);

		expect(preparation!.commit()).toBe(true);

		// alreadySurfaced + budget: second recall skips the selector entirely.
		const second = await backend.beforeAgentStartPrompt!(session, "another multi-word question");
		expect(second).toBeUndefined();
		expect(selectorCalls).toBe(1);
	});

	it("skips single-word prompts", async () => {
		const agentDir = await makeTempDir();
		const memoryDir = path.join(agentDir, "memory");
		await mkdir(memoryDir, { recursive: true });
		await writeFile(path.join(memoryDir, "topic.md"), "---\ntype: project\n---\nbody", "utf8");
		const { session } = fakeSession({ agentDir });
		let selectorCalls = 0;
		const backend = createClaudeMdBackend({
			complete: async () => {
				selectorCalls += 1;
				return '{"selected_memories": ["topic.md"]}';
			},
		});
		backend.start({
			session,
			settings: session.settings,
			modelRegistry: {} as never,
			agentDir,
			taskDepth: 0,
		});
		const preparation = await backend.beforeAgentStartPrompt!(session, "deploy");
		expect(preparation).toBeUndefined();
		expect(selectorCalls).toBe(0);
	});

	it("returns undefined for sessions the backend did not start", async () => {
		const agentDir = await makeTempDir();
		const { session } = fakeSession({ agentDir });
		const backend = createClaudeMdBackend({ complete: async () => NO_MEMORY_JSON });
		expect(await backend.beforeAgentStartPrompt!(session, "a multi-word prompt")).toBeUndefined();
	});

	it("releases the session state on releaseClaudeMdSession (commit then returns false)", async () => {
		const agentDir = await makeTempDir();
		const memoryDir = path.join(agentDir, "memory");
		await mkdir(memoryDir, { recursive: true });
		await writeFile(path.join(memoryDir, "topic.md"), "---\ntype: project\n---\nbody words", "utf8");
		const { session } = fakeSession({ agentDir });
		const backend = createClaudeMdBackend({
			complete: async system => {
				if (system.startsWith("You are selecting memories")) return '{"selected_memories": ["topic.md"]}';
				return NO_MEMORY_JSON;
			},
		});
		backend.start({
			session,
			settings: session.settings,
			modelRegistry: {} as never,
			agentDir,
			taskDepth: 0,
		});
		const preparation = await backend.beforeAgentStartPrompt!(session, "multi word prompt here");
		expect(preparation).toBeDefined();
		releaseClaudeMdSession(session);
		expect(preparation!.commit()).toBe(false);
	});
});
