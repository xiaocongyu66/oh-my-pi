/**
 * BCP-47 tag normalization for the locale packs we ship. Unknown tags fall
 * back to English so a hostile or typo'd LANG never selects a missing pack.
 *
 * Packs may partially cover the key space: natural-key lookup falls back to
 * the English source string for any missing entry, so a new locale ships as
 * soon as its high-frequency surface is translated.
 */

export const AVAILABLE_LOCALES = [
	"en",
	"zh-CN",
	"zh-TW",
	"ja",
	"ko",
	"de",
	"fr",
	"es",
	"ru",
	"pt-BR",
	"vi",
	"th",
	"id",
	"fil",
	"ar",
	"fa",
	"uk",
	"pl",
	"nl",
	"sv",
	"fi",
	"tr",
	"my",
	"kk",
	"ky",
	"hi",
	"el",
	"bg",
	"ro",
	"ka",
	"tk",
	"ps",
	"ur",
] as const;

export type Locale = (typeof AVAILABLE_LOCALES)[number];

export function normalizeTag(tag: string): Locale {
	const lower = tag.trim().toLowerCase();
	if (!lower) return "en";
	for (const locale of AVAILABLE_LOCALES) {
		if (locale.toLowerCase() === lower) return locale;
	}
	// LANG-style values: `zh_CN.UTF-8`, `zh-TW`, `zh-Hant`, bare `zh`.
	const base = lower.split(/[-_.]/)[0];
	if (base === "zh") {
		return /tw|hk|mo|hant/.test(lower) ? "zh-TW" : "zh-CN";
	}
	if (base === "pt") {
		return "pt-BR";
	}
	for (const locale of AVAILABLE_LOCALES) {
		const prefix = locale.toLowerCase().split(/[-_.]/)[0];
		if (prefix === base) return locale;
	}
	return "en";
}
