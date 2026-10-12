import { t } from "@oh-my-pi/pi-i18n";
import { localizeToolName } from "../i18n/tool-labels";

export interface ToolsMarkdownBindings {
	tools: ReadonlyArray<{ description: string; name: string }>;
	/** Tools mounted under `xd://` URLs, listed after the active set. */
	xdevTools?: ReadonlyArray<{ name: string; summary: string }>;
}

function escapeTableCell(value: string): string {
	return value
		.replace(/\|/g, "\\|")
		.replace(/\r?\n+/g, " ")
		.trim();
}

export function buildToolsMarkdown(bindings: ToolsMarkdownBindings): string {
	if (bindings.tools.length === 0 && !bindings.xdevTools?.length) {
		return t("No tools are currently visible to the agent.");
	}

	const rows: string[] = [];
	for (const tool of bindings.tools) {
		const description = escapeTableCell(tool.description) || t("No description provided.");
		// Name column shows the localized display name (plain text, not code —
		// the protocol name stays English in model-facing surfaces).
		rows.push(`| ${localizeToolName(tool.name)} | ${description} |`);
	}
	for (const mounted of bindings.xdevTools ?? []) {
		rows.push(`| \`xd://${mounted.name}\` | ${escapeTableCell(mounted.summary) || t("No description provided.")} |`);
	}

	return [t("| Tool | Description |"), "|------|-------------|", ...rows].join("\n");
}
