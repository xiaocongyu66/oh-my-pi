/**
 * `/search` registration + dispatch contracts: the builtin is registered for
 * autocomplete/ACP lookup, the TUI handler drives the panel primitives and
 * applies picks to the session state, and the ACP/text handler reports the
 * current state instead of pretending to be interactive.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	lookupBuiltinSlashCommand,
	executeBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import {
	ensureWebSearchSessionState,
	getWebSearchSessionState,
} from "@oh-my-pi/pi-coding-agent/web/search/session-state";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, overrides: { doubleEscapeAction: "none" } });
});

afterEach(() => {
	resetSettingsForTest();
});

/** Session double carrying the state getter and a minimal model registry. */
function fakeSession(): AgentSession {
	const session = {
		sessionId: "s1",
		getWebSearchSessionState: () => getWebSearchSessionState(session as unknown as AgentSession),
		modelRegistry: {
			authStorage: {
				keys: { source: () => undefined },
				credentials: { list: () => [], upsert: async () => [], disable: async () => true },
			},
		getAvailable: () => [
		{
			provider: "gemini",
			id: "gemini-2.5-pro",
			name: "Gemini 2.5 Pro",
			kind: "web",
			input: ["text"],
		},
	],
		},
	};
	return session as unknown as AgentSession;
}

function fakeRuntime(session: AgentSession, overrides: Partial<InteractiveModeContext> = {}) {
	return {
		ctx: {
			collabGuest: false,
			session,
			settings,
			editor: { setText: vi.fn() },
			showHookSelector: vi.fn(),
			showHookInput: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
			...overrides,
		} as unknown as InteractiveModeContext,
	};
}

describe("/search slash command", () => {
	it("is registered as a builtin with both TUI and ACP handlers", () => {
		const spec = lookupBuiltinSlashCommand("search");
		expect(spec).toBeDefined();
		expect(spec?.handleTui).toBeTypeOf("function");
		expect(spec?.handle).toBeTypeOf("function");
	});

	it("opens the panel and applies the search-model pick to the session state", async () => {
		const session = fakeSession();
		const state = ensureWebSearchSessionState(session);
		const showHookSelector = vi
			.fn()
			.mockResolvedValueOnce("Search model: off")
			.mockResolvedValueOnce("gemini/gemini-2.5-pro — Gemini 2.5 Pro");
		const runtime = fakeRuntime(session, { showHookSelector });

		expect(await executeBuiltinSlashCommand("/search", runtime)).toBe(true);

		// main menu → model submenu → main menu again (a later cancel exits the loop)
		expect(showHookSelector).toHaveBeenCalledTimes(3);
		expect(state.searchModel).toBe("gemini/gemini-2.5-pro");
	});

	it("toggles the search model off via the Off action", async () => {
		const session = fakeSession();
		const state = ensureWebSearchSessionState(session);
		state.searchModel = "web/duckduckgo";
		const showHookSelector = vi
			.fn()
			.mockResolvedValueOnce("Search model: web/duckduckgo")
			.mockResolvedValueOnce("Off");
		const runtime = fakeRuntime(session, { showHookSelector });

		expect(await executeBuiltinSlashCommand("/search", runtime)).toBe(true);
		expect(state.searchModel).toBeUndefined();
	});

	it("disables an engine through the engine sub-panel", async () => {
		const session = fakeSession();
		const state = ensureWebSearchSessionState(session);
		const showHookSelector = vi
			.fn()
			.mockResolvedValueOnce("Manage search engines")
			.mockResolvedValueOnce("brave")
			.mockResolvedValueOnce("Disable");
		const runtime = fakeRuntime(session, { showHookSelector });

		expect(await executeBuiltinSlashCommand("/search", runtime)).toBe(true);
		expect(state.disabledEngines.has("brave")).toBe(true);

		// Second pass re-enables through the same panel.
		showHookSelector.mockClear();
		showHookSelector
			.mockResolvedValueOnce("Manage search engines")
			.mockResolvedValueOnce("brave")
			.mockResolvedValueOnce("Enable");
		await executeBuiltinSlashCommand("/search", runtime);
		expect(state.disabledEngines.has("brave")).toBe(false);
	});

	it("cancelling the panel mutates nothing", async () => {
		const session = fakeSession();
		const runtime = fakeRuntime(session, { showHookSelector: vi.fn().mockResolvedValue(undefined) });

		expect(await executeBuiltinSlashCommand("/search", runtime)).toBe(true);
		expect(getWebSearchSessionState(session)).toBeUndefined();
	});

	it("the ACP handler reports the current state without any panel", async () => {
		const session = fakeSession();
		const outputs: string[] = [];
		const spec = lookupBuiltinSlashCommand("search");
		if (!spec?.handle) throw new Error("Expected /search ACP handler");
		const result = await spec.handle({ name: "search", args: "", text: "/search" }, {
			session,
			sessionManager: {} as never,
			settings: {} as never,
			cwd: "/tmp",
			output: (text: string) => {
				outputs.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		} as never);

		expect(result).toEqual({ consumed: true });
		expect(outputs.some(text => text.includes("Search model: off"))).toBe(true);
	});
});
