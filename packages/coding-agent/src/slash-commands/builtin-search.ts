/**
 * `/search` — interactive panel for the session's web-search runtime state:
 * hosted search model, multimodal image parsing, and per-engine management
 * (enable/disable + API-key provisioning). State is memory-only for the
 * session's lifetime (see `web/search/session-state.ts`); the only persistent
 * writes are engine API keys, which go into omp's credential store via
 * `authStorage.credentials` — never into settings or config files.
 */

import { t } from "@oh-my-pi/pi-i18n";
import { getEnvApiKey, type AuthCredential } from "@oh-my-pi/pi-ai";
import { roleCandidatePool } from "../config/model-roles";
import type { AuthStorage } from "../session/auth-storage";
import { SEARCH_ENGINE_CREDENTIAL_PROVIDERS, searchEngineIds } from "../web/search/provider";
import {
	describeWebSearchSessionState,
	ensureWebSearchSessionState,
	getWebSearchSessionState,
} from "../web/search/session-state";
import { clearSubmittedText } from "./helpers/draft";
import { commandConsumed } from "./helpers/parse";
import type {
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
	TuiSlashCommandRuntime,
} from "./types";

/** Selector string stored in session state and fed to web_search's params.model. */
function modelSelector(provider: string, id: string): string {
	return `${provider}/${id}`;
}

/** Reasonable cap so a large catalog does not turn the panel into an unbounded list. */
const MAX_MODEL_CANDIDATES = 40;

/** Cause persisted with disabled credential tombstones so `/usage` explains the row. */
const CLEARED_KEY_CAUSE = "cleared via /search";

const OFF_LABEL = "Off";
const ENABLE_LABEL = "Enable";
const DISABLE_LABEL = "Disable";
const SET_KEY_LABEL = "Set API key";
const CLEAR_KEY_LABEL = "Clear API key";
const ENGINES_LABEL = "Manage search engines";
const SEARCH_MODEL_PREFIX = "Search model:";
const MULTIMODAL_PREFIX = "Multimodal image parsing:";

/** Whether `authStorage`/env already carries a key for the engine's credential provider. */
function engineKeyConfigured(authStorage: AuthStorage, credentialProvider: string): boolean {
	return authStorage.keys.source(credentialProvider) !== undefined || !!getEnvApiKey(credentialProvider);
}

async function handleSearch(_command: ParsedSlashCommand, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	await runtime.output(describeWebSearchSessionState(runtime.session.getWebSearchSessionState()));
	await runtime.output(t("Interactive configuration is available in the TUI via /search."));
	return commandConsumed();
}

async function handleSearchTui(_command: ParsedSlashCommand, runtime: TuiSlashCommandRuntime): Promise<void> {
	clearSubmittedText(runtime);
	const ctx = runtime.ctx;
	const session = ctx.session;
	// Read through the plain getter: opening the panel must not materialize a
	// state object; only an actual toggle creates one.
	const state = () => getWebSearchSessionState(session);
	const modelRegistry = session.modelRegistry;
	if (!modelRegistry) {
		ctx.showStatus(t("No model registry available in this session."));
		return;
	}
	const authStorage = modelRegistry.authStorage;

	// Panel loop: main menu → one sub-panel per entry. `picked` resolves to the
	// picked option label (showHookSelector contract); undefined = cancelled.
	for (;;) {
		const picked = await ctx.showHookSelector(t("Web search settings"), [
			{
				label: `${SEARCH_MODEL_PREFIX} ${state()?.searchModel ?? "off"}`,
				description: t("Host every web_search call in this session through the selected model"),
			},
			{
				label: `${MULTIMODAL_PREFIX} ${state()?.multimodalModel ?? "off"}`,
				description: t("Describe image results with a vision model and append the description to snippets"),
			},
			{
				label: ENGINES_LABEL,
				description: t("Enable, disable, and provision API keys for individual search engines"),
			},
		]);
		if (!picked) return;
		if (picked.startsWith(SEARCH_MODEL_PREFIX)) {
			const pool = roleCandidatePool("web", ctx.settings, modelRegistry);
			const candidates = pool.slice(0, MAX_MODEL_CANDIDATES).map(model => ({
				label: modelSelector(model.provider, model.id),
				description: model.name,
			}));
			if (pool.length > candidates.length) {
				ctx.showStatus(t("Showing the first {{count}} search-capable models.", { count: candidates.length }));
			}
			const modelPicked = await ctx.showHookSelector(t("Search model"), [OFF_LABEL, ...candidates]);
			if (modelPicked === undefined) continue;
			// Selector labels round-trip exactly; anything else is the Off action.
			ensureWebSearchSessionState(session).searchModel = modelPicked === OFF_LABEL ? undefined : modelPicked;
			ctx.showStatus(t("Search model: {{value}}", { value: state()?.searchModel ?? "off" }));
			continue;
		}
		if (picked.startsWith(MULTIMODAL_PREFIX)) {
			const visionCandidates = modelRegistry
				.getAvailable("all")
				.filter(model => model.input.includes("image"))
				.slice(0, MAX_MODEL_CANDIDATES)
				.map(model => ({
					label: modelSelector(model.provider, model.id),
					description: model.name,
				}));
			if (visionCandidates.length === 0) {
				ctx.showStatus(t("No image-capable models are configured; enable a vision provider first."));
				continue;
			}
			const modelPicked = await ctx.showHookSelector(t("Multimodal image parsing"), [
				OFF_LABEL,
				...visionCandidates,
			]);
			if (modelPicked === undefined) continue;
			ensureWebSearchSessionState(session).multimodalModel = modelPicked === OFF_LABEL ? undefined : modelPicked;
			ctx.showStatus(t("Multimodal image parsing: {{value}}", { value: state()?.multimodalModel ?? "off" }));
			continue;
		}
		if (picked !== ENGINES_LABEL) return;

		// Engine management: list every pure engine with its key state, then a
		// per-engine sub-panel with enable/disable + key provisioning.
		const engine = await ctx.showHookSelector(
			t("Search engines"),
			searchEngineIds().map(id => {
				const credentialProvider = SEARCH_ENGINE_CREDENTIAL_PROVIDERS[id];
				const keyState = credentialProvider
					? engineKeyConfigured(authStorage, credentialProvider)
						? t("API key set")
						: t("no API key")
					: t("no key required");
				const disabled = state()?.disabledEngines.has(id) ? t(" · disabled") : "";
				return { label: id, description: `${keyState}${disabled}` };
			}),
		);
		if (!engine) continue;
		const credentialProvider =
			SEARCH_ENGINE_CREDENTIAL_PROVIDERS[engine as keyof typeof SEARCH_ENGINE_CREDENTIAL_PROVIDERS];
		const actions = [
			state()?.disabledEngines.has(engine) ? ENABLE_LABEL : DISABLE_LABEL,
			...(credentialProvider ? [SET_KEY_LABEL, CLEAR_KEY_LABEL] : []),
		];
		const action = await ctx.showHookSelector(t("Engine {{engine}}", { engine }), actions);
		if (!action) continue;
		try {
			if (action === ENABLE_LABEL || action === DISABLE_LABEL) {
				const nowDisabled = action === DISABLE_LABEL;
				const engines = ensureWebSearchSessionState(session).disabledEngines;
				if (nowDisabled) engines.add(engine);
				else engines.delete(engine);
				ctx.showStatus(
					nowDisabled
						? t("Engine {{engine}} disabled for aggregate search.", { engine })
						: t("Engine {{engine}} enabled.", { engine }),
				);
			} else if (action === SET_KEY_LABEL && credentialProvider) {
				// No masking primitive exists on this input; the value is never
				// echoed back and only ever lands in the credential store.
				const key = (await ctx.showHookInput(t("API key for {{engine}}", { engine })))?.trim();
				if (!key) {
					ctx.showStatus(t("No key entered; {{engine}} unchanged.", { engine }));
					continue;
				}
				const credential: AuthCredential = { type: "api_key", key };
				await authStorage.credentials.upsert(credentialProvider, credential);
				ctx.showStatus(t("API key saved for {{engine}}.", { engine }));
			} else if (action === CLEAR_KEY_LABEL && credentialProvider) {
				const rows = authStorage.credentials.list(credentialProvider);
				let cleared = 0;
				for (const row of rows) {
					if (await authStorage.credentials.disable(row.id, CLEARED_KEY_CAUSE)) cleared++;
				}
				ctx.showStatus(
					cleared > 0
						? t("Cleared {{count}} API key(s) for {{engine}}.", { count: cleared, engine })
						: t("No stored API key for {{engine}}.", { engine }),
				);
			}
		} catch (error) {
			ctx.showError(error instanceof Error ? error.message : String(error));
		}
	}
}

export const BUILTIN_SEARCH_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "search",
		icon: "globe",
		description: "Open the web search panel: hosted search model, multimodal parsing, engine management",
		acpDescription: "Show web search session settings",
		handle: handleSearch,
		handleTui: handleSearchTui,
	},
];
