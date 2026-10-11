/**
 * i18n infrastructure — natural-key scheme.
 *
 * The English UI string IS the key. Call sites wrap user-visible strings with
 * t('...'); when the active locale pack has an entry, its translation is
 * returned, otherwise the English string passes through unchanged. English
 * needs no pack entry and migration is incremental.
 *
 * Locale resolution order:
 *   1. the registered locale provider (settings `ui.locale` in coding-agent)
 *   2. OMP_LANGUAGE env var
 *   3. LANG env var (suppressed by OMP_LANGUAGE_ENFORCE_EN)
 *   4. 'en' (the strings in code — always available)
 *
 * Translations live in ../locales/<tag>.json as flat string-to-string maps.
 * The provider hook keeps this package dependency-free: consumers that store
 * settings inject a reader instead of this package importing them.
 */
import zhTW from "../locales/zh-TW.json";
import zhCN from "../locales/zh-CN.json";
import { AVAILABLE_LOCALES, normalizeTag, type Locale } from "./normalize";

export { AVAILABLE_LOCALES, normalizeTag };
export type { Locale };

const PACKS: Partial<Record<Locale, Record<string, string>>> = {
	"zh-CN": zhCN,
	"zh-TW": zhTW,
};

export interface TOptions {
	[name: string]: unknown;
}

type LocaleProvider = () => string | null | undefined;

let localeProvider: LocaleProvider | null = null;
let resolved: Locale | null = null;

/**
 * Install the highest-priority locale source (e.g. `() => cfgUiLocale.get(settings)`).
 * Pass null to unregister. Replaces any previous provider.
 */
export function registerLocaleProvider(provider: LocaleProvider | null): void {
	localeProvider = provider;
	resolved = null;
}

function isEnvTruthy(value: string | undefined): boolean {
	if (!value) return false;
	const lower = value.trim().toLowerCase();
	return lower === "1" || lower === "y" || lower === "yes" || lower === "true" || lower === "on";
}

export function resolveLocale(): Locale {
	if (resolved) return resolved;
	const fromProvider = localeProvider?.();
	if (fromProvider) {
		resolved = normalizeTag(fromProvider);
		return resolved;
	}
	const omp = process.env.OMP_LANGUAGE;
	if (omp) {
		resolved = normalizeTag(omp);
		return resolved;
	}
	const lang = process.env.LANG;
	if (lang && !isEnvTruthy(process.env.OMP_LANGUAGE_ENFORCE_EN)) {
		resolved = normalizeTag(lang);
		return resolved;
	}
	resolved = "en";
	return resolved;
}

/** Active locale tag ('en' when no locale pack is selected). */
export function currentLocale(): Locale {
	return resolveLocale();
}

/**
 * Drop the cached resolution so the next lookup re-reads provider and env.
 * Needed after persisting a new ui.locale mid-session (/language) and in
 * tests that swap OMP_LANGUAGE/LANG between cases.
 */
export function resetI18n(): void {
	resolved = null;
}

function interpolate(template: string, options?: TOptions): string {
	if (!options) return template;
	return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
		Object.hasOwn(options, name) ? String(options[name]) : match,
	);
}

/** Own-property lookup only: a bare `pack[key]` would let `Object.prototype` members leak. */
function lookup(pack: Record<string, string> | undefined, key: string): string | undefined {
	return pack && Object.hasOwn(pack, key) ? pack[key] : undefined;
}

/**
 * Translate a user-visible UI string into the active locale. The input is the
 * English text; untranslated strings pass through as-is. Interpolation uses
 * `{{name}}` placeholders substituted from `options`; keys in locale packs
 * keep the placeholders so translation controls word order.
 *
 * NEVER use this for text sent to the model (tool descriptions, tool results,
 * thrown error messages) — those are protocol surface and stay English.
 */
export function t(key: string, options?: TOptions): string {
	if (!key) return key;
	const locale = resolveLocale();
	if (locale === "en") return interpolate(key, options);
	const translated = lookup(PACKS[locale], key);
	return interpolate(translated ?? key, options);
}

/**
 * Count-sensitive variant for languages with no grammatical number (Chinese)
 * where both keys carry the same translation. English selects `singular` when
 * count is exactly 1; other locales look up `singular` first, then `plural`,
 * and fall back to the English selection for missing keys.
 */
export function tCount(singular: string, plural: string, options: TOptions & { count: number }): string {
	const pickEnglish = () => (options.count === 1 ? singular : plural);
	const locale = resolveLocale();
	if (locale === "en") return interpolate(pickEnglish(), options);
	const pack = PACKS[locale];
	const translated = lookup(pack, singular) ?? lookup(pack, plural);
	return interpolate(translated ?? pickEnglish(), options);
}
