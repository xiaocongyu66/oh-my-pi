/**
 * Modal `/language` selector.
 *
 * A small centered overlay listing the locales the UI can be pinned to, with
 * the active one preselected. Labels are English i18n keys resolved through
 * `t()` at construction time, so reopening the selector reflects a freshly
 * applied locale. `runLanguageSelector` mounts the panel via
 * `host.ui.showOverlay` + `host.ui.setFocus`, resolves with the chosen locale
 * (`undefined` on cancel) and always hides the overlay on the way out.
 */
import { type Locale, t } from "@oh-my-pi/pi-i18n";
import {
	type Component,
	type OverlayFocusOwner,
	type OverlayHandle,
	type OverlayOptions,
	type SelectItem,
	SelectList,
	type SgrMouseEvent,
} from "../index";
import { OverlayPanel } from "../chrome/overlay-box";
import { routeSelectListMouseWithTopBorder } from "../chrome/select-list-mouse-routing";
import { getSelectListTheme } from "../theme/theme";

/** Locales the UI can be pinned to; `auto` defers to OMP_LANGUAGE/LANG. Mirrors `cfgUiLocale` values. */
export type UiLocaleChoice = "auto" | Locale;

/**
 * Slice of `InteractiveModeContext` the selector drives. Narrow so tests can
 * exercise the open → choose → hide lifecycle without a real TUI.
 */
export interface LanguageSelectorHost {
	ui: {
		showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
		setFocus(component: Component): void;
	};
}

/** Selector rows; rebuilt per construction so `t()` sees the active locale. */
function localeItems(): SelectItem[] {
	return [
		{ value: "auto", label: t("Auto"), description: t("Follow the system language (OMP_LANGUAGE or LANG)") },
		{ value: "en", label: t("English") },
		{ value: "zh-CN", label: "简体中文", description: t("Simplified Chinese") },
		{ value: "zh-TW", label: "繁體中文", description: t("Traditional Chinese") },
	];
}

/**
 * Name for a locale choice in status copy: the Chinese locales show the native
 * name plus an English gloss so the confirmation reads in either language;
 * the rest use the translated label.
 */
const DISPLAY_NAMES: Partial<Record<UiLocaleChoice, string>> = {
	en: "English",
	"zh-CN": "简体中文 (Simplified Chinese)",
	"zh-TW": "繁體中文 (Traditional Chinese)",
	ja: "日本語 (Japanese)",
	ko: "한국어 (Korean)",
	de: "Deutsch (German)",
	fr: "Français (French)",
	es: "Español (Spanish)",
	ru: "Русский (Russian)",
	"pt-BR": "Português (Brazilian Portuguese)",
	vi: "Tiếng Việt (Vietnamese)",
	th: "ไทย (Thai)",
	id: "Bahasa Indonesia (Indonesian)",
	fil: "Filipino (Filipino)",
	ar: "العربية (Arabic)",
	fa: "فارسی (Persian)",
	uk: "Українська (Ukrainian)",
	pl: "Polski (Polish)",
	nl: "Nederlands (Dutch)",
	sv: "Svenska (Swedish)",
	fi: "Suomi (Finnish)",
	tr: "Türkçe (Turkish)",
	my: "မြန်မာ (Burmese)",
	kk: "Қазақша (Kazakh)",
	ky: "Кыргызча (Kyrgyz)",
	hi: "हिन्दी (Hindi)",
	el: "Ελληνικά (Greek)",
	bg: "Български (Bulgarian)",
	ro: "Română (Romanian)",
	ka: "ქართული (Georgian)",
	tk: "Türkmençe (Turkmen)",
	ps: "پښتو (Pashto)",
	ur: "اردو (Urdu)",
};

export function languageDisplayName(locale: UiLocaleChoice): string {
	if (locale === "auto") return t("Auto");
	return DISPLAY_NAMES[locale] ?? locale;
}

/** Modal overlay component; resolves {@link run} with the chosen locale, or undefined on cancel. */
export class LanguageSelectorComponent extends OverlayPanel implements OverlayFocusOwner {
	#selectList: SelectList;
	#done = Promise.withResolvers<UiLocaleChoice | undefined>();
	#resolved = false;

	constructor(current: UiLocaleChoice) {
		super(t("Language"), "omp.overlay.language");

		const items = localeItems();
		this.#selectList = new SelectList(items, items.length, getSelectListTheme());

		// Preselect the active locale.
		const currentIndex = items.findIndex(item => item.value === current);
		if (currentIndex !== -1) {
			this.#selectList.setSelectedIndex(currentIndex);
		}

		this.#selectList.onSelect = item => {
			this.#resolve(item.value as UiLocaleChoice);
		};

		this.#selectList.onCancel = () => {
			this.#resolve(undefined);
		};

		this.addChild(this.#selectList);
	}

	#resolve(choice: UiLocaleChoice | undefined): void {
		if (this.#resolved) return;
		this.#resolved = true;
		this.#done.resolve(choice);
	}

	/** Resolves with the chosen locale once the user picks one or cancels. */
	run(): Promise<UiLocaleChoice | undefined> {
		return this.#done.promise;
	}

	ownsOverlayFocusTarget(component: Component): boolean {
		return component === this.#selectList;
	}

	/** The panel holds focus; keys drive the list exactly as when it is focused directly. */
	handleInput(data: string): void {
		this.#selectList.handleInput(data);
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		routeSelectListMouseWithTopBorder(this.#selectList, event, line, col);
	}
}

/**
 * Show the modal language selector and resolve with the chosen locale
 * (`undefined` on cancel). Always hides the overlay on the way out.
 */
export async function runLanguageSelector(
	host: LanguageSelectorHost,
	current: UiLocaleChoice,
): Promise<UiLocaleChoice | undefined> {
	const component = new LanguageSelectorComponent(current);
	const overlay = host.ui.showOverlay(component, { anchor: "center", width: 72, maxHeight: "90%" });
	try {
		host.ui.setFocus(component);
		return await component.run();
	} finally {
		component.dispose();
		host.ui.setFocus(component);
		overlay.hide();
	}
}
