import { beforeEach, afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings, resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { __resetDirsFromEnvForTests, setAgentDir } from "@oh-my-pi/pi-utils";
import { parseMemoryShortcut, routeMemoryShortcut } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-memory";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntime() {
	const handleMemoryCommand = vi.fn(async () => {});
	const setText = vi.fn();
	const addToHistory = vi.fn();
	return {
		handleMemoryCommand,
		setText,
		addToHistory,
		runtime: {
			ctx: {
				editor: { setText, addToHistory } as unknown as InteractiveModeContext["editor"],
				handleMemoryCommand,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/memory slash command", () => {
	it("routes the full command text through the memory handler and saves it to history", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/memory view", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.handleMemoryCommand).toHaveBeenCalledWith("/memory view");
	});

	it("preserves the raw command text for history", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/memory    stats", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.handleMemoryCommand).toHaveBeenCalledWith("/memory    stats");
	});
});

// ============================================================================
// `#` quick-memory shortcut (Claude Code parity)
// ============================================================================

describe("parseMemoryShortcut", () => {
	it("extracts content after the hash", () => {
		expect(parseMemoryShortcut("# always run bun test first")).toBe("always run bun test first");
	});

	it("trims leading whitespace and surrounding space", () => {
		expect(parseMemoryShortcut("   #   spaced note  ")).toBe("spaced note");
	});

	it("returns null for bare hash, non-hash, and mid-string hash", () => {
		expect(parseMemoryShortcut("#")).toBeNull();
		expect(parseMemoryShortcut("plain text")).toBeNull();
		expect(parseMemoryShortcut("look at issue #42")).toBeNull();
		expect(parseMemoryShortcut("")).toBeNull();
	});

	it("handles tab-indented hashes", () => {
		expect(parseMemoryShortcut("\t# tabbed note")).toBe("tabbed note");
	});
});

describe("routeMemoryShortcut", () => {
	let agentDir: string;
	let savedClaudeConfigDir: string | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		agentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-hash-memory-"));
		// Redirect the process-wide agent dir so claudemd writes land in the
		// temp tree (never the developer's real ~/.omp).
		setAgentDir(agentDir);
		savedClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
		// Keep CC interop from flipping the write target to a real ~/.claude.
		process.env.CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), "omp-hash-memory-no-cc");
	});

	afterEach(async () => {
		if (savedClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = savedClaudeConfigDir;
		resetSettingsForTest();
		__resetDirsFromEnvForTests();
		await fsp.rm(agentDir, { recursive: true, force: true });
	});

	function shortcutRuntime(overrides: Record<string, unknown> = {}) {
		const settings = Settings.isolated({ "memory.backend": "claudemd" });
		const outputs: string[] = [];
		const runtime = {
			session: { sessionId: "hash-session", settings },
			settings,
			cwd: agentDir,
			output: async (text: string) => {
				outputs.push(text);
			},
			...overrides,
		} as never;
		return { runtime, outputs };
	}

	it("saves a memory through the claudemd backend and reports it", async () => {
		const { runtime, outputs } = shortcutRuntime();

		const result = await routeMemoryShortcut("# prefer bun test over npm test", runtime);

		expect(result).toEqual({ consumed: true });
		expect(outputs.join("\n")).toContain("Saved");
		const memoryDir = path.join(agentDir, "memory");
		const files = await fsp.readdir(memoryDir);
		expect(files.some(f => f.endsWith(".md") && f !== "MEMORY.md")).toBe(true);
		const index = await fsp.readFile(path.join(memoryDir, "MEMORY.md"), "utf8");
		expect(index).toContain("prefer bun test over npm test");
	});

	it("honors a Type: user prefix", async () => {
		const { runtime } = shortcutRuntime();

		await routeMemoryShortcut("# Type: user the user prefers terse answers", runtime);

		const memoryDir = path.join(agentDir, "memory");
		const topic = (await fsp.readdir(memoryDir)).find(f => f.endsWith(".md") && f !== "MEMORY.md");
		expect(topic).toBeDefined();
		const body = await fsp.readFile(path.join(memoryDir, topic!), "utf8");
		expect(body).toContain("type: user");
	});

	it("reports a backend without save support and still consumes the input", async () => {
		const settings = Settings.isolated({ "memory.backend": "off" });
		const outputs: string[] = [];
		const runtime = {
			session: { sessionId: "hash-session", settings },
			settings,
			cwd: agentDir,
			output: async (text: string) => {
				outputs.push(text);
			},
		} as never;

		const result = await routeMemoryShortcut("# not saved", runtime);

		expect(result).toEqual({ consumed: true });
		expect(outputs.join("\n")).toContain("off");
	});

	it("reports save failures without throwing", async () => {
		const { runtime, outputs } = shortcutRuntime();
		const backend = await (async () => {
			const resolved = await import("@oh-my-pi/pi-coding-agent/memory-backend").then(m =>
				m.resolveMemoryBackend(runtime.settings),
			);
			return resolved;
		})();
		const originalSave = backend.save;
		(backend as { save: typeof originalSave }).save = async () => {
			throw new Error("disk full");
		};

		const result = await routeMemoryShortcut("# fails on write", runtime);

		expect(result).toEqual({ consumed: true });
		expect(outputs.join("\n")).toContain("disk full");
		(backend as { save: typeof originalSave }).save = originalSave!;
	});
});

describe("# shortcut via executeBuiltinSlashCommand (TUI)", () => {
	it("blocks collab guests and does not touch the backend", async () => {
		resetSettingsForTest();
		const agentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-hash-guest-"));
		setAgentDir(agentDir);
		const settings = Settings.isolated({ "memory.backend": "claudemd" });
		const showStatus = vi.fn();
		const setText = vi.fn();
		const runtime = {
			ctx: {
				collabGuest: true,
				showStatus,
				editor: { setText } as never,
				session: { settings },
				sessionManager: { getCwd: () => agentDir },
				settings,
			} as unknown as InteractiveModeContext,
		};

		const handled = await executeBuiltinSlashCommand("# guest note", runtime);

		expect(handled).toBe(true);
		// Locale-stable: exactly one localized status message, editor cleared.
		expect(showStatus).toHaveBeenCalledTimes(1);
		expect(setText).toHaveBeenCalledWith("");
		// Distinguishing check: a regressed guest gate would route this through
		// backend.save and create the memory directory — it must stay untouched.
		expect(fs.existsSync(path.join(agentDir, "memory"))).toBe(false);
		__resetDirsFromEnvForTests();
		await fsp.rm(agentDir, { recursive: true, force: true });
	});
});
