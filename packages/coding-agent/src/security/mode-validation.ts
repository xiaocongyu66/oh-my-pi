/**
 * Mode-based permission handling for bash, ported from CC's
 * modeValidation.ts: in acceptEdits mode the plain filesystem commands are
 * auto-allowed (their path arguments have already been through
 * checkPathConstraints, which still asks on out-of-working-dir targets in
 * ask-preserving modes and on dangerous removal paths everywhere).
 */

const ACCEPT_EDITS_ALLOWED_COMMANDS = ["mkdir", "touch", "rm", "rmdir", "mv", "cp", "sed"] as const;

type FilesystemCommand = (typeof ACCEPT_EDITS_ALLOWED_COMMANDS)[number];

function isFilesystemCommand(command: string): command is FilesystemCommand {
	return (ACCEPT_EDITS_ALLOWED_COMMANDS as readonly string[]).includes(command);
}

/** First word of a segment, CC-style (whitespace split). */
export function baseCommandOf(segment: string): string {
	return segment.trim().split(/\s+/)[0] ?? "";
}

/**
 * Returns an allow decision when the current mode auto-approves this
 * segment, or undefined to continue through the normal flow.
 */
export function modeAllowForSegment(
	segment: string,
	mode: "default" | "acceptEdits" | "plan" | "bypassPermissions" | "dontAsk" | "auto",
): { behavior: "allow"; decisionReason: { type: "mode"; mode: typeof mode } } | undefined {
	if (mode !== "acceptEdits") return undefined;
	if (!isFilesystemCommand(baseCommandOf(segment))) return undefined;
	return { behavior: "allow", decisionReason: { type: "mode", mode } };
}

/** Commands the current mode auto-approves (empty outside acceptEdits). */
export function getAutoAllowedCommands(
	mode: "default" | "acceptEdits" | "plan" | "bypassPermissions" | "dontAsk" | "auto",
): readonly string[] {
	return mode === "acceptEdits" ? ACCEPT_EDITS_ALLOWED_COMMANDS : [];
}
