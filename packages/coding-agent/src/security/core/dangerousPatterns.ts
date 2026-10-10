/**
 * Pattern lists for dangerous shell-tool allow rules, ported from Claude Code.
 *
 * An allow rule like `bash(python:*)` or `bash(node:*)` lets the model run
 * arbitrary code via that interpreter, bypassing rule review and the auto-mode
 * classifier. These lists feed `isDangerousBashPermission`, which strips such
 * rules when entering auto mode.
 */

/** Cross-platform code-execution entry points (present on Unix and Windows). */
export const CROSS_PLATFORM_CODE_EXEC = [
	// Interpreters
	"python",
	"python3",
	"python2",
	"node",
	"deno",
	"tsx",
	"ruby",
	"perl",
	"php",
	"lua",
	// Package runners
	"npx",
	"bunx",
	"npm run",
	"yarn run",
	"pnpm run",
	"bun run",
	// Shells reachable from both platforms
	"bash",
	"sh",
	// Remote arbitrary-command wrapper
	"ssh",
] as const;

/** Bash allow-rule shapes that amount to arbitrary code execution. */
export const DANGEROUS_BASH_PATTERNS: readonly string[] = [
	...CROSS_PLATFORM_CODE_EXEC,
	"zsh",
	"fish",
	"eval",
	"exec",
	"env",
	"xargs",
	"sudo",
];
