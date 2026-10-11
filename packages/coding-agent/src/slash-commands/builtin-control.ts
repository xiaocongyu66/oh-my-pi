import { normalizeTag, resetI18n, t } from "@oh-my-pi/pi-i18n";
import {
	languageDisplayName,
	runLanguageSelector,
	type UiLocaleChoice,
} from "@oh-my-pi/pi-tui/overlays/language-selector";
import { runPauseScreen } from "@oh-my-pi/pi-tui/overlays/pause-screen";
import { cfgUiLocale } from "../config/i18n-settings";
import { settings } from "../config/settings";
import { clearSubmittedText } from "./helpers/draft";
import { shutdownHandlerTui } from "./builtin-lifecycle";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import type { SlashCommandSpec, TuiSlashCommandRuntime } from "./types";

/** Persist a locale choice and repaint the chrome that renders translated strings. */
function applyUiLocale(runtime: TuiSlashCommandRuntime, value: UiLocaleChoice): void {
	cfgUiLocale.set(settings, value);
	resetI18n();
	runtime.ctx.statusLine.invalidate();
	runtime.ctx.ui.invalidate();
	runtime.ctx.ui.requestRender();
	// Rebuild the system prompt now so the model's reply-language directive
	// follows the switch this turn instead of waiting for a later rebuild.
	void runtime.ctx.session.reconcileBuiltinTools({ refreshPrompt: true }).catch(() => {});
	runtime.ctx.showStatus(
		t("UI language set to {{language}}. Panels and menus update now; existing chat history stays English.", {
			language: languageDisplayName(value),
		}),
	);
}

export const BUILTIN_CONTROL_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "force",
		icon: "hammer",
		description: "Force next turn to use a specific tool",
		aliases: ["force:"],
		inlineHint: "<tool-name> [prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const count = runtime.ctx.session.getActiveToolNames().length;
			return count === 0 ? t("Force: no active tools") : t("Force: {{count}} active tools", { count });
		},
		handle: async (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();
			if (!toolName) return usage("Usage: /force:<tool-name> [prompt]", runtime);
			try {
				runtime.session.setForcedToolChoice(toolName);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			await runtime.output(`Next turn forced to use ${toolName}.`);
			return prompt ? { prompt } : commandConsumed();
		},
		handleTui: (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();

			if (!toolName) {
				runtime.ctx.showError(t("Usage: /force:<tool-name> [prompt]"));
				clearSubmittedText(runtime);
				return;
			}

			try {
				runtime.ctx.session.setForcedToolChoice(toolName);
				runtime.ctx.showStatus(t("Next turn forced to use {{tool}}.", { tool: toolName }));
			} catch (error) {
				runtime.ctx.showError(errorMessage(error));
				clearSubmittedText(runtime);
				return;
			}

			clearSubmittedText(runtime);

			// If a prompt was provided, pass it through as input
			if (prompt) return { prompt };
		},
	},
	{
		name: "live",
		icon: "voice",
		description: "Start Codex-backed realtime voice mode",
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.handleLiveCommand();
		},
	},
	{
		name: "record",
		icon: "export",
		description: "Start or stop recording this screen to a replayable file (omp play)",
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.toggleRecording();
		},
	},
	{
		name: "pause",
		icon: "pause",
		description: "Freeze all agents (main, subagents, advisor) until resumed",
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runPauseScreen(runtime.ctx);
		},
	},
	{
		name: "quit",
		aliases: ["q"],
		icon: "power",
		description: "Quit the application",
		handleTui: shutdownHandlerTui,
	},
	{
		name: "language",
		icon: "globe",
		description: "Switch the UI language",
		inlineHint: "[auto|en|zh-CN|zh-TW]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			const args = command.args.trim();
			if (!args) {
				const choice = await runLanguageSelector(runtime.ctx, cfgUiLocale.get(settings));
				if (!choice) return;
				applyUiLocale(runtime, choice);
				return;
			}
			const value: UiLocaleChoice = args.toLowerCase() === "auto" ? "auto" : normalizeTag(args);
			applyUiLocale(runtime, value);
		},
	},
];
