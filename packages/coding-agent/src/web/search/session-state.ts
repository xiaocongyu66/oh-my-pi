/**
 * Per-session runtime overrides for the web_search tool, set via the `/search`
 * slash command. Memory-only by contract: state lives on the AgentSession
 * (symbol-keyed, same pattern as `mnemopi/state.ts`) and never touches
 * settings, config files, or disk — it dies with the process.
 */
import type { AgentSession } from "../../session/agent-session";

export interface WebSearchSessionState {
	/**
	 * Model selector (same format as web_search's `params.model`, e.g.
	 * `gemini/gemini-2.5-pro` or `web/duckduckgo`) that hosts the session's
	 * web searches. Present = hosting enabled; absent = default role chain.
	 */
	searchModel?: string;
	/**
	 * Vision-capable model selector that describes image results. Present =
	 * multimodal parsing enabled; absent = off.
	 */
	multimodalModel?: string;
	/** Engines the user disabled for aggregate search (checked by engine id). */
	disabledEngines: Set<string>;
}

const kWebSearchSessionState = Symbol("websearch.sessionState");

interface AgentSessionWithWebSearchState extends AgentSession {
	[kWebSearchSessionState]?: WebSearchSessionState;
}

export function getWebSearchSessionState(session: AgentSession): WebSearchSessionState | undefined {
	return (session as AgentSessionWithWebSearchState)[kWebSearchSessionState];
}

export function setWebSearchSessionState(
	session: AgentSession,
	state: WebSearchSessionState | undefined,
): WebSearchSessionState | undefined {
	const typed = session as AgentSessionWithWebSearchState;
	const previous = typed[kWebSearchSessionState];
	if (state) typed[kWebSearchSessionState] = state;
	else delete typed[kWebSearchSessionState];
	return previous;
}

/** Get-or-create so toggles can mutate one state object in place. */
export function ensureWebSearchSessionState(session: AgentSession): WebSearchSessionState {
	const typed = session as AgentSessionWithWebSearchState;
	let state = typed[kWebSearchSessionState];
	if (!state) {
		state = { disabledEngines: new Set() };
		typed[kWebSearchSessionState] = state;
	}
	return state;
}

/** One-line summary for the panel/ACP status output; `Off` when unset. */
export function describeWebSearchSessionState(state: WebSearchSessionState | undefined): string {
	if (!state) return "Search model: off; Multimodal image parsing: off; Disabled engines: none";
	const parts = [
		`Search model: ${state.searchModel ?? "off"}`,
		`Multimodal image parsing: ${state.multimodalModel ?? "off"}`,
		`Disabled engines: ${state.disabledEngines.size > 0 ? [...state.disabledEngines].sort().join(", ") : "none"}`,
	];
	return parts.join("; ");
}
