import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	collectRecentSuccessfulTools,
	findRelevantMemories,
	formatMemoryInjection,
	formatSelectorUserPrompt,
	MAX_MEMORY_BYTES,
	MAX_SESSION_BYTES,
	MAX_SELECTED_MEMORIES,
	memoryAge,
	memoryAgeDays,
	memoryFreshnessText,
	memoryHeader,
	parseSelectorResponse,
	readMemoriesForSurfacing,
	type SelectMemoriesFn,
} from "../../src/memory/claudemd-backend/recall";

let tempDir: string | undefined;

async function makeTempDir(): Promise<string> {
	tempDir = await mkdtemp(path.join(os.tmpdir(), "claudemd-recall-"));
	return tempDir;
}

afterEach(async () => {
	if (tempDir) {
		await rm(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

async function writeMemory(dir: string, filename: string, content: string): Promise<void> {
	await mkdir(path.dirname(path.join(dir, filename)), { recursive: true });
	await writeFile(path.join(dir, filename), content, "utf8");
}

function memoryFile(description: string, body = "Some memory content."): string {
	return `---\nname: test\ndescription: ${description}\ntype: project\n---\n\n${body}\n`;
}

/** Fake selector returning a canned `{selected_memories}` JSON payload. */
function fakeSelector(names: string[]): SelectMemoriesFn {
	return async () => JSON.stringify({ selected_memories: names });
}

/** Tracking selector that records its inputs and returns canned names. */
function trackingSelector(names: string[]) {
	const calls: { query: string; manifest: string; tools: readonly string[] }[] = [];
	const select: SelectMemoriesFn = async (query, manifest, tools) => {
		calls.push({ query, manifest, tools });
		return JSON.stringify({ selected_memories: names });
	};
	return { select, calls };
}

describe("parseSelectorResponse", () => {
	it("parses the selected_memories array", () => {
		expect(parseSelectorResponse('{"selected_memories": ["a.md", "b.md"]}')).toEqual(["a.md", "b.md"]);
	});

	it("strips a code-fenced payload", () => {
		expect(parseSelectorResponse('```json\n{"selected_memories": ["a.md"]}\n```')).toEqual(["a.md"]);
	});

	it("returns [] for non-JSON or malformed payloads", () => {
		expect(parseSelectorResponse("not json")).toEqual([]);
		expect(parseSelectorResponse('{"wrong": []}')).toEqual([]);
		expect(parseSelectorResponse('{"selected_memories": "a.md"}')).toEqual([]);
		expect(parseSelectorResponse('{"selected_memories": [1, 2]}')).toEqual([]);
	});
});

describe("findRelevantMemories", () => {
	it("returns at most 5 memories", async () => {
		const dir = await makeTempDir();
		for (let i = 0; i < 10; i++) {
			await writeMemory(dir, `f${i}.md`, memoryFile(`About topic ${i}`));
		}
		const selected = await findRelevantMemories({
			query: "tell me about the topics",
			memoryDir: dir,
			select: fakeSelector(Array.from({ length: 10 }, (_, i) => `f${i}.md`)),
		});
		expect(selected).toHaveLength(MAX_SELECTED_MEMORIES);
	});

	it("filters hallucinated filenames against the scanned candidate set", async () => {
		const dir = await makeTempDir();
		await writeMemory(dir, "real.md", memoryFile("Real memory"));
		const selected = await findRelevantMemories({
			query: "what about real",
			memoryDir: dir,
			select: fakeSelector(["real.md", "hallucinated.md"]),
		});
		expect(selected).toHaveLength(1);
		expect(selected[0]!.path).toBe(path.join(dir, "real.md"));
	});

	it("skips the selector entirely when the candidate list is empty", async () => {
		const dir = await makeTempDir();
		let called = false;
		const selected = await findRelevantMemories({
			query: "anything at all",
			memoryDir: dir,
			select: async () => {
				called = true;
				return '{"selected_memories": []}';
			},
		});
		expect(selected).toEqual([]);
		expect(called).toBe(false);
	});

	it("excludes alreadySurfaced paths before the selector runs", async () => {
		const dir = await makeTempDir();
		await writeMemory(dir, "fresh.md", memoryFile("Fresh"));
		await writeMemory(dir, "seen.md", memoryFile("Already seen"));
		const { select, calls } = trackingSelector(["fresh.md"]);
		const selected = await findRelevantMemories({
			query: "user question here",
			memoryDir: dir,
			select,
			alreadySurfaced: new Set([path.join(dir, "seen.md")]),
		});
		expect(selected).toHaveLength(1);
		expect(selected[0]!.path).toBe(path.join(dir, "fresh.md"));
		// The manifest must not advertise the surfaced file either.
		expect(calls[0]!.manifest).not.toContain("seen.md");
		expect(calls[0]!.manifest).toContain("fresh.md");
	});

	it("passes the verbatim user template with query, manifest, and tools section", async () => {
		const dir = await makeTempDir();
		await writeMemory(dir, "a.md", memoryFile("Alpha"));
		const { select, calls } = trackingSelector(["a.md"]);
		await findRelevantMemories({
			query: "how do I deploy",
			memoryDir: dir,
			select,
			recentTools: ["bash", "read"],
		});
		expect(calls[0]!.query).toBe("how do I deploy");
		expect(calls[0]!.tools).toEqual(["bash", "read"]);
		expect(formatSelectorUserPrompt("how do I deploy", calls[0]!.manifest, calls[0]!.tools)).toBe(
			`Query: how do I deploy\n\nAvailable memories:\n${calls[0]!.manifest}\n\nRecently used tools: bash, read`,
		);
		expect(formatSelectorUserPrompt("q words here", "manifest", [])).toBe("Query: q words here\n\nAvailable memories:\nmanifest");
	});

	it("returns [] on selector failure (best-effort)", async () => {
		const dir = await makeTempDir();
		await writeMemory(dir, "a.md", memoryFile("Alpha"));
		const selected = await findRelevantMemories({
			query: "question with words",
			memoryDir: dir,
			select: async () => {
				throw new Error("LLM down");
			},
		});
		expect(selected).toEqual([]);
	});
});

describe("readMemoriesForSurfacing", () => {
	it("truncates long files at the byte cap with the verbatim truncation note", async () => {
		const dir = await makeTempDir();
		const longBody = "x".repeat(MAX_MEMORY_BYTES + 2000);
		await writeMemory(dir, "big.md", memoryFile("Big file", longBody));
		const surfaced = await readMemoriesForSurfacing([{ path: path.join(dir, "big.md"), mtimeMs: Date.now() }]);
		expect(surfaced).toHaveLength(1);
		expect(surfaced[0]!.content).toContain(
			`> This memory file was truncated (${MAX_MEMORY_BYTES} byte limit). Use the Read tool to view the complete file at: ${path.join(dir, "big.md")}`,
		);
		expect(surfaced[0]!.content.indexOf("x".repeat(50))).toBeLessThan(MAX_MEMORY_BYTES);
	});

	it("truncates at the line cap with the line-count note", async () => {
		const dir = await makeTempDir();
		const lines: string[] = [];
		for (let i = 0; i < 300; i++) lines.push(`line ${i}`);
		await writeMemory(dir, "lines.md", memoryFile("Many lines", lines.join("\n")));
		const surfaced = await readMemoriesForSurfacing([{ path: path.join(dir, "lines.md"), mtimeMs: Date.now() }]);
		expect(surfaced[0]!.content).toContain(
			`> This memory file was truncated (first 200 lines). Use the Read tool to view the complete file at: ${path.join(dir, "lines.md")}`,
		);
		expect(surfaced[0]!.content).not.toContain("line 250");
	});

	it("returns untouched content under both caps", async () => {
		const dir = await makeTempDir();
		await writeMemory(dir, "small.md", memoryFile("Small", "tiny body"));
		const surfaced = await readMemoriesForSurfacing([{ path: path.join(dir, "small.md"), mtimeMs: Date.now() }]);
		expect(surfaced[0]!.content).not.toContain("truncated");
	});

	it("drops unreadable files", async () => {
		const dir = await makeTempDir();
		const surfaced = await readMemoriesForSurfacing([{ path: path.join(dir, "missing.md"), mtimeMs: Date.now() }]);
		expect(surfaced).toEqual([]);
	});
});

describe("formatMemoryInjection", () => {
	it("renders one system-reminder block with per-memory headers", () => {
		const block = formatMemoryInjection([
			{ path: "/mem/a.md", content: "alpha content", mtimeMs: Date.now(), header: memoryHeader("/mem/a.md", Date.now()), byteCount: 13 },
			{
				path: "/mem/b.md",
				content: "beta content",
				mtimeMs: Date.now() - 5 * 86_400_000,
				header: memoryHeader("/mem/b.md", Date.now() - 5 * 86_400_000),
				byteCount: 12,
			},
		]);
		expect(block.startsWith("<system-reminder>")).toBe(true);
		expect(block.endsWith("</system-reminder>")).toBe(true);
		expect(block).toContain("## Relevant memories");
		expect(block).toContain(`Memory (saved ${memoryAge(Date.now())}): /mem/a.md:\n\nalpha content`);
		expect(block).toContain("This memory is 5 days old.");
		expect(block).toContain("beta content");
	});
});

describe("memory age helpers", () => {
	it("computes age days with floor rounding and clamping", () => {
		expect(memoryAgeDays(Date.now())).toBe(0);
		expect(memoryAgeDays(Date.now() - 86_400_000 - 1000)).toBe(1);
		expect(memoryAgeDays(Date.now() + 86_400_000)).toBe(0);
	});

	it("returns no freshness text for fresh memories", () => {
		expect(memoryFreshnessText(Date.now())).toBe("");
		expect(memoryFreshnessText(Date.now() - 86_400_000)).toBe("");
		expect(memoryFreshnessText(Date.now() - 2 * 86_400_000)).toContain("This memory is 2 days old.");
	});

	it("formats the stale header with the caveat and fresh header with age", () => {
		const old = memoryHeader("/mem/old.md", Date.now() - 3 * 86_400_000);
		expect(old.startsWith("This memory is 3 days old. Memories are point-in-time observations")).toBe(true);
		expect(old).toContain("\n\nMemory: /mem/old.md:");
		expect(memoryHeader("/mem/new.md", Date.now())).toBe(`Memory (saved today): /mem/new.md:`);
	});
});

describe("collectRecentSuccessfulTools", () => {
	function msg(partial: Partial<AgentMessage> & { role: AgentMessage["role"] }): AgentMessage {
		return { timestamp: Date.now(), content: "", ...partial } as AgentMessage;
	}

	it("collects tools with successful results and no errors since the last user turn", () => {
		const messages: AgentMessage[] = [
			msg({ role: "user" }),
			msg({ role: "toolResult", toolName: "bash", isError: false } as Partial<AgentMessage>),
			msg({ role: "toolResult", toolName: "read", isError: false } as Partial<AgentMessage>),
			msg({ role: "assistant" }),
		];
		expect(collectRecentSuccessfulTools(messages)).toEqual(["bash", "read"]);
	});

	it("excludes tools with any error result in the window", () => {
		const messages: AgentMessage[] = [
			msg({ role: "user" }),
			msg({ role: "toolResult", toolName: "bash", isError: false } as Partial<AgentMessage>),
			msg({ role: "toolResult", toolName: "bash", isError: true } as Partial<AgentMessage>),
			msg({ role: "assistant" }),
		];
		expect(collectRecentSuccessfulTools(messages)).toEqual([]);
	});

	it("stops at the previous user message", () => {
		const messages: AgentMessage[] = [
			msg({ role: "user" }),
			msg({ role: "toolResult", toolName: "older", isError: false } as Partial<AgentMessage>),
			msg({ role: "assistant" }),
			msg({ role: "user" }),
			msg({ role: "toolResult", toolName: "newer", isError: false } as Partial<AgentMessage>),
		];
		expect(collectRecentSuccessfulTools(messages)).toEqual(["newer"]);
	});
});

describe("session byte budget", () => {
	it("matches the CC 60 KiB constant", () => {
		expect(MAX_SESSION_BYTES).toBe(60 * 1024);
	});
});
