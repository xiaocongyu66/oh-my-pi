/**
 * Safe-tool allowlist for auto mode, ported from Claude Code's
 * classifierDecision.ts `SAFE_YOLO_ALLOWLISTED_TOOLS`, re-targeted at omp's
 * builtin tool names. Tools listed here skip classifier API calls entirely.
 * Write/edit/exec tools are deliberately absent — file edits are handled by
 * the acceptEdits fast path in core/decision.ts and command execution by the
 * classifier itself.
 */

export const DEFAULT_SAFE_ALLOWLISTED_TOOLS: readonly string[] = [
	// Read-only file operations and search
	"read",
	"grep",
	"glob",
	"find",
	"lsp",
	"ast_grep",
	// Task management (metadata only)
	"todo",
	"task",
	// Scheduling / wait
	"wait",
	// Plan mode / user interaction
	"ask",
	// Context management
	"context_notes",
	"new_context",
];

/** Tools that are safe and don't need any classifier checking. */
export function isSafeAllowlistedTool(toolName: string, allowlist: ReadonlySet<string>): boolean {
	return allowlist.has(toolName);
}
