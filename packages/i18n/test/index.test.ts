import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import zhTW from "../locales/zh-TW.json";
import zhCN from "../locales/zh-CN.json";
import { currentLocale, normalizeTag, registerLocaleProvider, resetI18n, resolveLocale, t, tCount } from "../src";
import { AVAILABLE_LOCALES } from "../src/normalize";

describe("normalizeTag", () => {
	test("maps exact tags", () => {
		expect(normalizeTag("zh-CN")).toBe("zh-CN");
		expect(normalizeTag("zh-TW")).toBe("zh-TW");
		expect(normalizeTag("en")).toBe("en");
		expect(normalizeTag("EN")).toBe("en");
	});

	test("maps LANG-style values with encoding suffixes", () => {
		expect(normalizeTag("zh_CN.UTF-8")).toBe("zh-CN");
		expect(normalizeTag("zh_TW.utf8")).toBe("zh-TW");
		expect(normalizeTag("en_US.UTF-8")).toBe("en");
	});

	test("maps bare zh to simplified and Hant variants to traditional", () => {
		expect(normalizeTag("zh")).toBe("zh-CN");
		expect(normalizeTag("zh-Hant")).toBe("zh-TW");
		expect(normalizeTag("zh-HK")).toBe("zh-TW");
		expect(normalizeTag("zh-MO")).toBe("zh-TW");
	});

	test("unknown languages fall back to en", () => {
		expect(normalizeTag("ja")).toBe("en");
		expect(normalizeTag("fr_FR")).toBe("en");
		expect(normalizeTag("")).toBe("en");
		expect(normalizeTag("   ")).toBe("en");
	});

	test("available locales are declared once", () => {
		expect([...AVAILABLE_LOCALES]).toEqual(["en", "zh-CN", "zh-TW"]);
	});
});

describe("resolveLocale", () => {
	const saved = {
		omp: process.env.OMP_LANGUAGE,
		lang: process.env.LANG,
		enforce: process.env.OMP_LANGUAGE_ENFORCE_EN,
	};

	beforeEach(() => {
		resetI18n();
		registerLocaleProvider(null);
		delete process.env.OMP_LANGUAGE;
		delete process.env.LANG;
		delete process.env.OMP_LANGUAGE_ENFORCE_EN;
	});

	afterEach(() => {
		for (const [key, value] of Object.entries({
			OMP_LANGUAGE: saved.omp,
			LANG: saved.lang,
			OMP_LANGUAGE_ENFORCE_EN: saved.enforce,
		})) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		registerLocaleProvider(null);
		resetI18n();
	});

	test("provider wins over env", () => {
		process.env.OMP_LANGUAGE = "zh-TW";
		registerLocaleProvider(() => "zh_CN.UTF-8");
		expect(resolveLocale()).toBe("zh-CN");
	});

	test("OMP_LANGUAGE wins over LANG", () => {
		process.env.OMP_LANGUAGE = "zh-TW";
		process.env.LANG = "zh_CN.UTF-8";
		expect(resolveLocale()).toBe("zh-TW");
	});

	test("LANG is the last env source", () => {
		process.env.LANG = "zh_TW.UTF-8";
		expect(resolveLocale()).toBe("zh-TW");
	});

	test("ENFORCE_EN suppresses LANG but not explicit settings or OMP_LANGUAGE", () => {
		process.env.OMP_LANGUAGE_ENFORCE_EN = "1";
		process.env.LANG = "zh_CN.UTF-8";
		expect(resolveLocale()).toBe("en");
		process.env.OMP_LANGUAGE = "zh-CN";
		resetI18n();
		expect(resolveLocale()).toBe("zh-CN");
	});

	test("defaults to en", () => {
		expect(resolveLocale()).toBe("en");
		expect(currentLocale()).toBe("en");
	});

	test("provider errors and blanks fall through", () => {
		registerLocaleProvider(() => "");
		expect(resolveLocale()).toBe("en");
	});

	test("resetI18n invalidates the cached resolution", () => {
		expect(resolveLocale()).toBe("en");
		process.env.OMP_LANGUAGE = "zh-CN";
		// Stale until reset — mirrors /language persisting ui.locale mid-session.
		expect(resolveLocale()).toBe("en");
		resetI18n();
		expect(resolveLocale()).toBe("zh-CN");
	});
});

describe("t", () => {
	const saved = { ...process.env };

	beforeEach(() => {
		resetI18n();
		registerLocaleProvider(null);
		delete process.env.OMP_LANGUAGE;
		delete process.env.LANG;
	});

	afterEach(() => {
		process.env.OMP_LANGUAGE = saved.OMP_LANGUAGE;
		process.env.LANG = saved.LANG;
		registerLocaleProvider(null);
		resetI18n();
	});

	test("empty key passes through", () => {
		expect(t("")).toBe("");
	});

	test("english passes templates through and interpolates locally", () => {
		expect(t("Loading settings")).toBe("Loading settings");
		expect(t("Loaded {{n}} messages", { n: 5 })).toBe("Loaded 5 messages");
		expect(t("Keeps {{missing}}", { other: 1 })).toBe("Keeps {{missing}}");
	});

	test("untranslated keys fall back to the English text in other locales", () => {
		registerLocaleProvider(() => "zh-CN");
		resetI18n();
		expect(t("A sentence no pack contains")).toBe("A sentence no pack contains");
	});

	test("Object.prototype members never masquerade as translations", () => {
		registerLocaleProvider(() => "zh-CN");
		resetI18n();
		expect(t("__proto__")).toBe("__proto__");
		expect(t("toString")).toBe("toString");
		expect(typeof t("constructor")).toBe("string");
		expect(t("Keeps {{constructor}}", {})).toBe("Keeps {{constructor}}");
	});
});

describe("tCount", () => {
	const saved = { ...process.env };

	beforeEach(() => {
		resetI18n();
		registerLocaleProvider(null);
		delete process.env.OMP_LANGUAGE;
		delete process.env.LANG;
	});

	afterEach(() => {
		process.env.OMP_LANGUAGE = saved.OMP_LANGUAGE;
		process.env.LANG = saved.LANG;
		registerLocaleProvider(null);
		resetI18n();
	});

	test("english selects by grammatical number", () => {
		expect(tCount("{{count}} job", "{{count}} jobs", { count: 1 })).toBe("1 job");
		expect(tCount("{{count}} job", "{{count}} jobs", { count: 3 })).toBe("3 jobs");
		expect(tCount("{{count}} job", "{{count}} jobs", { count: 0 })).toBe("0 jobs");
	});
});

describe("locale packs", () => {
	const PACKS: Record<string, Record<string, string>> = { "zh-CN": zhCN, "zh-TW": zhTW };

	test("zh-TW mirrors the zh-CN key set exactly", () => {
		expect(Object.keys(zhTW).sort()).toEqual(Object.keys(zhCN).sort());
	});

	test("no translation is a stub equal to the English key", () => {
		for (const [locale, pack] of Object.entries(PACKS)) {
			for (const [key, value] of Object.entries(pack)) {
				if (value === key) throw new Error(`${locale} has stub translation for: ${key}`);
			}
		}
	});

	test("every placeholder in a translation exists in the key", () => {
		const placeholders = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]).sort();
		for (const [locale, pack] of Object.entries(PACKS)) {
			for (const [key, value] of Object.entries(pack)) {
				const missing = placeholders(value).filter(name => !placeholders(key).includes(name));
				if (missing.length > 0)
					throw new Error(`${locale} key "${key}" injects unknown placeholders: ${missing.join(", ")}`);
			}
		}
	});
});
