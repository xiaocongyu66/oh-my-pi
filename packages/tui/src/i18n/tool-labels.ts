/**
 * Display-layer localization for tool labels and job-type tags.
 *
 * Scope contract (user-directed): these translations apply ONLY to
 * user-visible TUI chrome (tool titles, transcript rows). The model-facing
 * protocol layer keeps the canonical tool names (`bash`, `edit`, …) and the
 * `AgentTool.label` values remain the English identity everywhere else —
 * this module wraps them at render time and falls back to the original
 * string for any locale without a catalog entry.
 */
import { t } from "@oh-my-pi/pi-i18n";

/** Localize a tool display label ("Bash" → "执行" under zh locales). */
export function localizeToolLabel(label: string): string {
	return t(label);
}

/**
 * Localize a protocol tool name ("read" → "读取", "web_search" → "网络搜索").
 * Falls back to the raw name for anything without a label translation
 * (extension tools, xd:// devices).
 */
export function localizeToolName(name: string): string {
	const label = name.replace(/[_-]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
	const localized = t(label);
	return localized === label ? name : localized;
}

/** Localize a background-job type tag ("[bash]" → "[执行]"). */
export function localizeJobTypeTag(type: string): string {
	return t(`[${type}]`);
}
