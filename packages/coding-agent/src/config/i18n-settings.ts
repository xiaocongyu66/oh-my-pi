/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { AVAILABLE_LOCALES, normalizeTag, registerLocaleProvider, type Locale } from "@oh-my-pi/pi-i18n";
import { register } from "./registry";
import { findScopedSettings } from "./settings";

/** `auto` keeps the OS signal (OMP_LANGUAGE/LANG) in charge; explicit tags pin the UI language. */
const UI_LOCALE_VALUES = ["auto", ...AVAILABLE_LOCALES] as const;

const NATIVE_LOCALE_NAMES: Record<string, { label: string; description?: string }> = {
	en: { label: "English" },
	"zh-CN": { label: "简体中文", description: "Simplified Chinese" },
	"zh-TW": { label: "繁體中文", description: "Traditional Chinese" },
	ja: { label: "日本語", description: "Japanese" },
	ko: { label: "한국어", description: "Korean" },
	de: { label: "Deutsch", description: "German" },
	fr: { label: "Français", description: "French" },
	es: { label: "Español", description: "Spanish" },
	ru: { label: "Русский", description: "Russian" },
	"pt-BR": { label: "Português (Brasil)", description: "Brazilian Portuguese" },
	vi: { label: "Tiếng Việt", description: "Vietnamese" },
	th: { label: "ไทย", description: "Thai" },
	id: { label: "Bahasa Indonesia", description: "Indonesian" },
	fil: { label: "Filipino", description: "Filipino" },
	ar: { label: "العربية", description: "Arabic" },
	fa: { label: "فارسی", description: "Persian" },
	uk: { label: "Українська", description: "Ukrainian" },
	pl: { label: "Polski", description: "Polish" },
	nl: { label: "Nederlands", description: "Dutch" },
	sv: { label: "Svenska", description: "Swedish" },
	fi: { label: "Suomi", description: "Finnish" },
	tr: { label: "Türkçe", description: "Turkish" },
	my: { label: "မြန်မာ", description: "Burmese" },
	kk: { label: "Қазақша", description: "Kazakh" },
	ky: { label: "Кыргызча", description: "Kyrgyz" },
	hi: { label: "हिन्दी", description: "Hindi" },
	el: { label: "Ελληνικά", description: "Greek" },
	bg: { label: "Български", description: "Bulgarian" },
	ro: { label: "Română", description: "Romanian" },
	ka: { label: "ქართული", description: "Georgian" },
	tk: { label: "Türkmençe", description: "Turkmen" },
	ps: { label: "پښتو", description: "Pashto" },
	ur: { label: "اردو", description: "Urdu" },
};

export const cfgUiLocale = register({
	id: "ui.locale",
	type: "enum",
	values: UI_LOCALE_VALUES,
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
		options: UI_LOCALE_VALUES.map(value =>
			value === "auto"
				? { value, label: "Auto", description: "Follow the system language (OMP_LANGUAGE or LANG)" }
				: {
						value,
						label: NATIVE_LOCALE_NAMES[value]?.label ?? value,
						description: NATIVE_LOCALE_NAMES[value]?.description,
					},
		),
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
