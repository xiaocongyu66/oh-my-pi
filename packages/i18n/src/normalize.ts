/**
 * BCP-47 tag normalization for the locale packs we ship. Unknown tags fall
 * back to English so a hostile or typo'd LANG never selects a missing pack.
 */

export const AVAILABLE_LOCALES = ["en", "zh-CN", "zh-TW"] as const;

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
	for (const locale of AVAILABLE_LOCALES) {
		const prefix = locale.toLowerCase().split(/[-_.]/)[0];
		if (prefix === base) return locale;
	}
	return "en";
}
