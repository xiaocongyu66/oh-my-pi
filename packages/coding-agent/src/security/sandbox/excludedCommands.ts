/**
 * `sandbox.excludedCommands` matching and the `shouldUseSandbox` gate, ported
 * from Claude Code's
 * `packages/builtin-tools/src/tools/BashTool/shouldUseSandbox.ts` plus the
 * helpers it leans on in `bashPermissions.ts` / `shellRuleMatching.ts`
 * (`parsePermissionRule`, `matchWildcardPattern`, `stripAllLeadingEnvVars`,
 * `stripSafeWrappers`, `BINARY_HIJACK_VARS`).
 *
 * Adaptations from Claude Code:
 * - Compound-command splitting uses omp's shared conservative tokenizer
 *   (`../../tools/shell-tokenize`, quote/escape aware) instead of the
 *   tree-sitter-backed `splitCommand_DEPRECATED`; untokenizable input falls
 *   back to treating the whole command as one segment.
 * - Dropped: the GrowthBook `tengu_sandbox_disabled_commands` dynamic config,
 *   the ant-only `USER_TYPE === "ant"` branch, and `ANT_ONLY_SAFE_ENV_VARS`
 *   (DOCKER_HOST / KUBECONFIG / ... stripping is intentionally not ported).
 * - No settings or SandboxManager imports: availability, the excluded list,
 *   and the unsandboxed-commands policy arrive as plain options.
 *
 * NOTE (kept from upstream): excludedCommands is a user-facing convenience
 * feature, not a security boundary. It is not a security bug to be able to
 * bypass excludedCommands — the sandbox permission system (which prompts
 * users) is the actual security control.
 *
 * This module must stay free of imports outside `../../tools/shell-tokenize`
 * and its own sandbox siblings.
 */

import { tokenizeShellSegments } from "../../tools/shell-tokenize";

// ============================================================================
// Permission rule parsing / matching (CC shellRuleMatching.ts port)
// ============================================================================

export type ShellPermissionRule =
	| { type: "exact"; command: string }
	| { type: "prefix"; prefix: string }
	| { type: "wildcard"; pattern: string };

/** Extract prefix from legacy `:*` syntax (e.g., "npm:*" -> "npm"). */
export function permissionRuleExtractPrefix(permissionRule: string): string | null {
	const match = permissionRule.match(/^(.+):\*$/);
	return match?.[1] ?? null;
}

/** True when the pattern contains unescaped wildcards (legacy `:*` excluded). */
export function hasWildcards(pattern: string): boolean {
	// If it ends with :*, it's legacy prefix syntax, not wildcard
	if (pattern.endsWith(":*")) return false;
	// An asterisk is unescaped unless preceded by an odd number of backslashes.
	for (let i = 0; i < pattern.length; i++) {
		if (pattern[i] === "*") {
			let backslashCount = 0;
			let j = i - 1;
			while (j >= 0 && pattern[j] === "\\") {
				backslashCount++;
				j--;
			}
			if (backslashCount % 2 === 0) return true;
		}
	}
	return false;
}

// Null-byte sentinel placeholders for wildcard pattern escaping — module-level
// so the RegExp objects are compiled once instead of per permission check.
const ESCAPED_STAR_PLACEHOLDER = "\x00ESCAPED_STAR\x00";
const ESCAPED_BACKSLASH_PLACEHOLDER = "\x00ESCAPED_BACKSLASH\x00";
const ESCAPED_STAR_PLACEHOLDER_RE = new RegExp(ESCAPED_STAR_PLACEHOLDER, "g");
const ESCAPED_BACKSLASH_PLACEHOLDER_RE = new RegExp(ESCAPED_BACKSLASH_PLACEHOLDER, "g");

/**
 * Match a command against a wildcard pattern (case-sensitive). Wildcards (`*`)
 * match any character sequence; `\*` matches a literal asterisk and `\\` a
 * literal backslash.
 */
export function matchWildcardPattern(pattern: string, command: string, caseInsensitive = false): boolean {
	const trimmedPattern = pattern.trim();

	// Process the pattern to handle escape sequences: \* and \\
	let processed = "";
	let i = 0;
	while (i < trimmedPattern.length) {
		const char = trimmedPattern[i];
		if (char === "\\" && i + 1 < trimmedPattern.length) {
			const nextChar = trimmedPattern[i + 1];
			if (nextChar === "*") {
				processed += ESCAPED_STAR_PLACEHOLDER;
				i += 2;
				continue;
			} else if (nextChar === "\\") {
				processed += ESCAPED_BACKSLASH_PLACEHOLDER;
				i += 2;
				continue;
			}
		}
		processed += char;
		i++;
	}

	// Escape regex special characters except *
	const escaped = processed.replace(/[.+?^${}()|[\]\\'"]/g, "\\$&");
	const withWildcards = escaped.replace(/\*/g, ".*");
	let regexPattern = withWildcards
		.replace(ESCAPED_STAR_PLACEHOLDER_RE, "\\*")
		.replace(ESCAPED_BACKSLASH_PLACEHOLDER_RE, "\\\\");

	// A trailing " *" (sole unescaped wildcard) also matches the bare command,
	// aligning wildcard matching with prefix-rule semantics ("git *" ~ "git:*").
	const unescapedStarCount = (processed.match(/\*/g) || []).length;
	if (regexPattern.endsWith(" .*") && unescapedStarCount === 1) {
		regexPattern = regexPattern.slice(0, -3) + "( .*)?";
	}

	// dotAll so wildcards match commands containing embedded newlines.
	const flags = "s" + (caseInsensitive ? "i" : "");
	return new RegExp(`^${regexPattern}$`, flags).test(command);
}

/** Parse a permission rule string into a structured rule object. */
export function parsePermissionRule(permissionRule: string): ShellPermissionRule {
	// Check for legacy :* prefix syntax first (backwards compatibility)
	const prefix = permissionRuleExtractPrefix(permissionRule);
	if (prefix !== null) return { type: "prefix", prefix };
	// Check for new wildcard syntax (contains * but not :* at end)
	if (hasWildcards(permissionRule)) return { type: "wildcard", pattern: permissionRule };
	// Otherwise, it's an exact match
	return { type: "exact", command: permissionRule };
}

// ============================================================================
// Env-var / wrapper stripping (CC bashPermissions.ts port)
// ============================================================================

/**
 * Env vars that make a *different binary* run (injection or resolution
 * hijack). Heuristic only — export-&& form bypasses this, and
 * excludedCommands isn't a security boundary anyway.
 */
export const BINARY_HIJACK_VARS = /^(LD_|DYLD_|PATH$)/;

/** Strips full-line comments (lines that are entirely a comment). */
function stripCommentLines(command: string): string {
	const lines = command.split("\n");
	const nonCommentLines = lines.filter(line => {
		const trimmed = line.trim();
		return trimmed !== "" && !trimmed.startsWith("#");
	});
	// If all lines were comments/empty, return original
	if (nonCommentLines.length === 0) return command;
	return nonCommentLines.join("\n");
}

// Whitelist of environment variables that are safe to strip from commands —
// these cannot execute code or load libraries. SECURITY: PATH, LD_PRELOAD,
// LD_LIBRARY_PATH, DYLD_*, PYTHONPATH, NODE_PATH, NODE_OPTIONS, HOME, ... must
// NEVER be added here. (CC's ant-only ANT_ONLY_SAFE_ENV_VARS is not ported.)
const SAFE_ENV_VARS = new Set([
	"GOEXPERIMENT",
	"GOOS",
	"GOARCH",
	"CGO_ENABLED",
	"GO111MODULE",
	"RUST_BACKTRACE",
	"RUST_LOG",
	"NODE_ENV",
	"PYTHONUNBUFFERED",
	"PYTHONDONTWRITEBYTECODE",
	"PYTEST_DISABLE_PLUGIN_AUTOLOAD",
	"PYTEST_DEBUG",
	"ANTHROPIC_API_KEY",
	"LANG",
	"LANGUAGE",
	"LC_ALL",
	"LC_CTYPE",
	"LC_TIME",
	"CHARSET",
	"TERM",
	"COLORTERM",
	"NO_COLOR",
	"FORCE_COLOR",
	"TZ",
	"LS_COLORS",
	"LSCOLORS",
	"GREP_COLOR",
	"GREP_COLORS",
	"GCC_COLORS",
	"TIME_STYLE",
	"BLOCK_SIZE",
	"BLOCKSIZE",
]);

// SECURITY: flag VALUES use allowlist [A-Za-z0-9_.+-] (signals are TERM/KILL/9,
// durations are 5/5s/10.5) — `[^ \t]+` would match $ ( ) ` | ; & and let
// `timeout -k$(id) 10 ls` strip to `ls` while bash expands $(id).
const SAFE_WRAPPER_PATTERNS = [
	// timeout: GNU long flags (no-value and value-taking, =fused and
	// space-separated) plus short flags, then the duration.
	/^timeout[ \t]+(?:(?:--(?:foreground|preserve-status|verbose)|--(?:kill-after|signal)=[A-Za-z0-9_.+-]+|--(?:kill-after|signal)[ \t]+[A-Za-z0-9_.+-]+|-v|-[ks][ \t]+[A-Za-z0-9_.+-]+|-[ks][A-Za-z0-9_.+-]+)[ \t]+)*(?:--[ \t]+)?\d+(?:\.\d+)?[smhd]?[ \t]+/,
	/^time[ \t]+(?:--[ \t]+)?/,
	// nice: bare, `-n N`, and legacy `-N`, with optional `--`.
	/^nice(?:[ \t]+-n[ \t]+-?\d+|[ \t]+-\d+)?[ \t]+(?:--[ \t]+)?/,
	// stdbuf: fused short flags only (-o0, -eL).
	/^stdbuf(?:[ \t]+-[ioe][LN0-9]+)+[ \t]+(?:--[ \t]+)?/,
	/^nohup[ \t]+(?:--[ \t]+)?/,
];

/**
 * Strip leading safe env vars and wrapper commands (timeout, time, nice,
 * stdbuf, nohup) from a command, iteratively, for permission matching.
 * Phase 1 strips safe env vars only; phase 2 strips wrappers only (VAR=val
 * after a wrapper is the command, not an assignment — HackerOne #3543050).
 */
export function stripSafeWrappers(command: string): string {
	// SECURITY: trailing whitespace MUST be [ \t]+ (horizontal only), NOT \s+ —
	// \n is a command separator in bash.
	const ENV_VAR_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_./:-]+)[ \t]+/;

	let stripped = command;
	let previousStripped = "";

	// Phase 1: Strip leading env vars and comments only.
	while (stripped !== previousStripped) {
		previousStripped = stripped;
		stripped = stripCommentLines(stripped);
		const envVarMatch = stripped.match(ENV_VAR_PATTERN);
		if (envVarMatch && SAFE_ENV_VARS.has(envVarMatch[1])) {
			stripped = stripped.replace(ENV_VAR_PATTERN, "");
		}
	}

	// Phase 2: Strip wrapper commands and comments only. Do NOT strip env vars.
	previousStripped = "";
	while (stripped !== previousStripped) {
		previousStripped = stripped;
		stripped = stripCommentLines(stripped);
		for (const pattern of SAFE_WRAPPER_PATTERNS) {
			stripped = stripped.replace(pattern, "");
		}
	}

	return stripped.trim();
}

/**
 * Strip ALL leading env var prefixes from a command, regardless of whether
 * the var name is in the safe-list. Used for sandbox.excludedCommands
 * matching (not a security boundary) with BINARY_HIJACK_VARS as a blocklist.
 *
 * SECURITY: broader value pattern than stripSafeWrappers; excludes only actual
 * shell injection characters. Trailing whitespace is [ \t]+ (horizontal only).
 */
export function stripAllLeadingEnvVars(command: string, blocklist?: RegExp): string {
	const ENV_VAR_PATTERN =
		/^([A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?)\+?=(?:'[^'\n\r]*'|"(?:\\.|[^"$`\\\n\r])*"|\\.|[^ \t\n\r$`;|&()<>\\\\'"])*[ \t]+/;

	let stripped = command;
	let previousStripped = "";

	while (stripped !== previousStripped) {
		previousStripped = stripped;
		stripped = stripCommentLines(stripped);
		const m = stripped.match(ENV_VAR_PATTERN);
		if (!m) continue;
		if (blocklist?.test(m[1])) break;
		stripped = stripped.slice(m[0].length);
	}

	return stripped.trim();
}

// ============================================================================
// excludedCommands matching (shouldUseSandbox.ts port)
// ============================================================================

/**
 * Check a command against user-configured excluded commands. Compound
 * commands are split into subcommands and each is matched independently, so
 * `docker ps && curl evil.com` cannot escape the sandbox just because its
 * first subcommand matches an excluded pattern. Each subcommand is also
 * matched with env var prefixes and wrapper commands stripped via a
 * fixed-point loop (handles interleaved `timeout 300 FOO=bar bazel run`).
 */
export function containsExcludedCommand(command: string, excludedCommands: readonly string[]): boolean {
	if (excludedCommands.length === 0) return false;

	// Split compound commands (e.g. "docker ps && curl evil.com") into
	// individual subcommands; fall back to the whole command when the
	// tokenizer cannot find structure.
	const segments = tokenizeShellSegments(command);
	const subcommands = segments.length > 0 ? segments.map(tokens => tokens.join(" ")) : [command];

	for (const subcommand of subcommands) {
		const trimmed = subcommand.trim();
		// Iteratively apply env-var and wrapper stripping until no new
		// candidates are produced (fixed-point), matching CC's approach in
		// filterRulesByContentsMatchingInput.
		const candidates = [trimmed];
		const seen = new Set(candidates);
		let startIdx = 0;
		while (startIdx < candidates.length) {
			const endIdx = candidates.length;
			for (let i = startIdx; i < endIdx; i++) {
				const cmd = candidates[i];
				const envStripped = stripAllLeadingEnvVars(cmd, BINARY_HIJACK_VARS);
				if (!seen.has(envStripped)) {
					candidates.push(envStripped);
					seen.add(envStripped);
				}
				const wrapperStripped = stripSafeWrappers(cmd);
				if (!seen.has(wrapperStripped)) {
					candidates.push(wrapperStripped);
					seen.add(wrapperStripped);
				}
			}
			startIdx = endIdx;
		}

		for (const pattern of excludedCommands) {
			const rule = parsePermissionRule(pattern);
			for (const cand of candidates) {
				switch (rule.type) {
					case "prefix":
						if (cand === rule.prefix || cand.startsWith(rule.prefix + " ")) return true;
						break;
					case "exact":
						if (cand === rule.command) return true;
						break;
					case "wildcard":
						if (matchWildcardPattern(rule.pattern, cand)) return true;
						break;
				}
			}
		}
	}

	return false;
}

// ============================================================================
// shouldUseSandbox
// ============================================================================

export type SandboxCommandInput = {
	command?: string;
	dangerouslyDisableSandbox?: boolean;
};

export type ShouldUseSandboxOptions = {
	/** True when the OS sandbox runtime is loaded and the platform supports it. */
	sandboxAvailable: boolean;
	/** `sandbox.allowUnsandboxedCommands` (CC default: true). */
	allowUnsandboxedCommands?: boolean;
	/** `sandbox.excludedCommands` (convenience, NOT a security boundary). */
	excludedCommands?: readonly string[];
};

/**
 * Decide whether a Bash call should run inside the OS sandbox. Ported from
 * CC's `shouldUseSandbox`; the ambient SandboxManager/settings reads became
 * `options`.
 */
export function shouldUseSandbox(input: Partial<SandboxCommandInput>, options: ShouldUseSandboxOptions): boolean {
	if (!options.sandboxAvailable) {
		return false;
	}

	// Don't sandbox if explicitly overridden AND unsandboxed commands are allowed by policy
	if (input.dangerouslyDisableSandbox && (options.allowUnsandboxedCommands ?? true)) {
		return false;
	}

	if (!input.command) {
		return false;
	}

	// Don't sandbox if the command contains user-configured excluded commands
	if (containsExcludedCommand(input.command, options.excludedCommands ?? [])) {
		return false;
	}

	return true;
}
