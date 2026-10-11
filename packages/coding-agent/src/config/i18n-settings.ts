/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { normalizeTag, registerLocaleProvider, type Locale } from "@oh-my-pi/pi-i18n";
import { register } from "./registry";
import { findScopedSettings } from "./settings";

/** `auto` keeps the OS signal (OMP_LANGUAGE/LANG) in charge; explicit tags pin the UI language. */
export const cfgUiLocale = register({
	id: "ui.locale",
	type: "enum",
	values: ["auto", "en", "zh-CN", "zh-TW"] as const,
	default: "auto",
	env: {
		name: "OMP_LANGUAGE",
		parse: (raw): "auto" | Locale | undefined => (raw.trim().toLowerCase() === "auto" ? "auto" : normalizeTag(raw)),
		fallback: true,
	},
	ui: {
		tab: "appearance",
		group: "Language",
		label: "Language",
		description: "UI language for panels, menus and status text; text sent to the model stays English",
		options: [
			{ value: "auto", label: "Auto", description: "Follow the system language (OMP_LANGUAGE or LANG)" },
			{ value: "en", label: "English" },
			{ value: "zh-CN", label: "简体中文", description: "Simplified Chinese" },
			{ value: "zh-TW", label: "繁體中文", description: "Traditional Chinese" },
		],
	},
});

// Highest-priority locale source for `@oh-my-pi/pi-i18n`: reads the active session's
// `ui.locale` lazily (undefined before Settings init and for `auto`, so the i18n package
// falls through to its own OMP_LANGUAGE/LANG resolution). Loading this domain — via
// `config/all-settings.ts` — installs the hook; processes that never load settings keep
// pure env-driven i18n.
registerLocaleProvider(() => {
	const settings = findScopedSettings();
	if (!settings) return undefined;
	const value = cfgUiLocale.get(settings);
	return value === "auto" ? undefined : value;
});
