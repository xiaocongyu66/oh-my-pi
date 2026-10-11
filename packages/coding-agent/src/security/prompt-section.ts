/**
 * Mode-aware system-prompt section for the permission engine. CC told the
 * model about its permission posture through the system prompt (plan-mode
 * text, auto-accept notices); enforcement itself is host-side, but without a
 * briefing the model only discovers the active mode by hitting denials.
 * This is that briefing: a short static preamble plus one mode paragraph.
 */

import type { Settings } from "../config/settings";
import { resolvePermissionMode } from "./settings";

const MODE_TEXT: Record<string, string> = {
	default:
		"Anything not covered by an allow rule prompts the user for approval. Expect occasional denials; when one happens, explain and propose an alternative instead of re-asking.",
	acceptEdits:
		"File edits inside the workspace are auto-approved. Commands and other state-changing actions still require user approval.",
	plan: "Plan mode is active: work read-only. Do not attempt file edits, writes, or command execution — research the codebase and present a plan for approval instead.",
	bypassPermissions:
		"Tool calls are auto-approved except bypass-immune safety checks (dangerous paths, injection patterns, explicit deny rules), which can still deny.",
	dontAsk:
		"No approval prompts are shown in this session: anything not explicitly allowed by a rule is denied automatically. Do not rely on interactive approval; prefer read-only exploration and tell the user which rule would unblock an action.",
	auto: "Unresolved permission asks are routed to an automated safety classifier; repeated denials fall back to prompting the user. Keep each requested action minimal and well-justified so the classifier can approve it.",
};

const PREAMBLE = [
	"## Permission System",
	"",
	"Every tool call is evaluated against permission rules and the session's approval mode before it runs; denials surface as tool errors stating the reason.",
	"Never retry a denied call unchanged — adjust the request, take a safer path, or ask the user.",
].join("\n");

/** Build the permission briefing for the current mode, or undefined if unknown. */
export function buildPermissionModeInstructions(settings: Settings): string | undefined {
	const mode = resolvePermissionMode(settings);
	const modeText = MODE_TEXT[mode];
	if (!modeText) {
		return undefined;
	}
	return `${PREAMBLE}\n\nCurrent mode: ${mode}. ${modeText}`;
}
