/**
 * Safe command preprocessing before permission-rule matching, ported verbatim
 * from CC's bashPermissions.ts stripSafeWrappers.
 *
 * Why this exists: users write `NO_COLOR=1 git status` or `timeout 10 git push`
 * while their rules say `Bash(git status:*)` / `Bash(git:*)`. Without
 * stripping, the raw command never matches the rule — deny rules under-block
 * (`NO_COLOR=1 denied_cmd` evades a deny) and allow rules never apply. The
 * stripped form is used for RULE MATCHING ONLY; the original command still
 * runs, and the security validators (bash-security.ts) always see the raw
 * text.
 *
 * SECURITY invariants preserved from CC:
 * - Wrapper/env patterns use [ \t]+ never \s+ — \n and \r are command
 *   separators, and stripping across a newline would let one line's wrapper
 *   hide a different command on the next line.
 * - Wrapper flag VALUES are allowlisted ([A-Za-z0-9_.+-]); `timeout
 *   -k$(id) 10 ls` must not strip because bash expands $(id) during word
 *   splitting before timeout runs.
 * - Env assignment values are allowlisted ([A-Za-z0-9_./:-]+) — no $(),
 *   backticks, or variable expansions.
 * - Phase 2 (wrappers) must NOT strip env vars: after a wrapper like
 *   `nohup`, VAR=val is the COMMAND to execute, not an assignment
 *   (HackerOne #3543050).
 */

const SAFE_ENV_VARS = new Set([
	// Go - build/runtime settings only
	"GOEXPERIMENT", // experimental features
	"GOOS", // target OS
	"GOARCH", // target architecture
	"CGO_ENABLED", // enable/disable CGO
	"GO111MODULE", // module mode

	// Rust - logging/debugging only
	"RUST_BACKTRACE", // backtrace verbosity
	"RUST_LOG", // logging filter

	// Node - environment name only (not NODE_OPTIONS!)
	"NODE_ENV",

	// Python - behavior flags only (not PYTHONPATH!)
	"PYTHONUNBUFFERED", // disable buffering
	"PYTHONDONTWRITEBYTECODE", // no .pyc files

	// Pytest - test configuration
	"PYTEST_DISABLE_PLUGIN_AUTOLOAD", // disable plugin loading
	"PYTEST_DEBUG", // debug output

	// API keys and authentication
	"ANTHROPIC_API_KEY", // API authentication

	// Locale and character encoding
	"LANG", // default locale
	"LANGUAGE", // language preference list
	"LC_ALL", // override all locale settings
	"LC_CTYPE", // character classification
	"LC_TIME", // time format
	"CHARSET", // character set preference

	// Terminal and display
	"TERM", // terminal type
	"COLORTERM", // color terminal indicator
	"NO_COLOR", // disable color output (universal standard)
	"FORCE_COLOR", // force color output
	"TZ", // timezone

	// Color configuration for various tools
	"LS_COLORS", // colors for ls (GNU)
	"LSCOLORS", // colors for ls (BSD/macOS)
	"GREP_COLOR", // grep match color (deprecated)
	"GREP_COLORS", // grep color scheme
	"GCC_COLORS", // GCC diagnostic colors

	// Display formatting
	"TIME_STYLE", // time display format for ls
	"BLOCK_SIZE", // block size for du/df
	"BLOCKSIZE", // alternative block size
]);

/**
 * Convenience-only environment variables that are safe to strip from commands
 * for rule matching. Gated on `OMP_BASH_STRIP_ADVANCED_ENV` instead of CC's
 * internal USER_TYPE check. Same risk note as CC: stripping happens before
 * permission-rule matching, so `DOCKER_HOST=tcp://evil.com docker ps` matches
 * a `Bash(docker ps:*)` rule after stripping. OFF by default.
 */
const ADVANCED_SAFE_ENV_VARS = new Set([
	// Kubernetes and container config (config file pointers, not execution)
	"KUBECONFIG", // kubectl config file path — controls which cluster kubectl uses
	"DOCKER_HOST", // Docker daemon socket/endpoint — controls which daemon docker talks to

	// Cloud provider project/profile selection (just names/identifiers)
	"AWS_PROFILE", // AWS profile name selection
	"CLOUDSDK_CORE_PROJECT", // GCP project ID
	"CLUSTER", // generic cluster name

	// Feature flags (boolean/string flags only)
	"SKIP_NODE_VERSION_CHECK", // skip version check
	"EXPECTTEST_ACCEPT", // accept test expectations
	"CI", // CI environment indicator
	"GIT_LFS_SKIP_SMUDGE", // skip LFS downloads

	// GPU/Device selection (just device IDs)
	"CUDA_VISIBLE_DEVICES", // GPU device selection
	"JAX_PLATFORMS", // JAX platform selection

	// Display/terminal settings
	"COLUMNS", // terminal width
	"TMUX", // TMUX socket info

	// Test/debug configuration
	"POSTGRESQL_VERSION", // postgres version string
	"FIRESTORE_EMULATOR_HOST", // emulator host:port
	"DBT_PER_DEVELOPER_ENVIRONMENTS", // DBT config

	// Version selectors
	"PYENV_VERSION", // Python version selection

	// Credentials (approved subset - these don't change exfil risk)
	"PGPASSWORD", // Postgres password
	"GH_TOKEN", // GitHub token
]);

/** Whether the opt-in advanced env stripping is enabled (default off, like CC's ant-only gate). */
function advancedStripEnabled(): boolean {
	return process.env.OMP_BASH_STRIP_ADVANCED_ENV === "1";
}

/**
 * Strips full-line comments from a command.
 * This handles cases where the model adds comments in bash commands, e.g.:
 *   "# Check the logs directory\nls /home/user/logs"
 * Should be stripped to: "ls /home/user/logs"
 *
 * Only strips full-line comments (lines where the entire line is a comment),
 * not inline comments that appear after a command on the same line.
 */
function stripCommentLines(command: string): string {
	const lines = command.split("\n");
	const nonCommentLines = lines.filter(line => {
		const trimmed = line.trim();
		// Keep lines that are not empty and don't start with #
		return trimmed !== "" && !trimmed.startsWith("#");
	});

	// If all lines were comments/empty, return original
	if (nonCommentLines.length === 0) {
		return command;
	}

	return nonCommentLines.join("\n");
}

export function stripSafeWrappers(command: string): string {
	// SECURITY: Use [ \t]+ not \s+ — \s matches \n/\r which are command
	// separators in bash. Matching across a newline would strip the wrapper from
	// one line and leave a different command on the next line for bash to execute.
	//
	// SECURITY: `(?:--[ \t]+)?` consumes the wrapper's own `--` so
	// `nohup -- rm -- -/../foo` strips to `rm -- -/../foo` (not `-- rm ...`
	// which would skip path validation with `--` as an unknown baseCmd).
	const SAFE_WRAPPER_PATTERNS = [
		// timeout: enumerate GNU long flags — no-value (--foreground,
		// --preserve-status, --verbose), value-taking in both =fused and
		// space-separated forms (--kill-after=5, --kill-after 5, --signal=TERM,
		// --signal TERM). Short: -v (no-arg), -k/-s with separate or fused value.
		// SECURITY: flag VALUES use allowlist [A-Za-z0-9_.+-] (signals are
		// TERM/KILL/9, durations are 5/5s/10.5). Previously [^ \t]+ matched
		// $ ( ) ` | ; & — `timeout -k$(id) 10 ls` stripped to `ls`, matched
		// Bash(ls:*), while bash expanded $(id) during word splitting BEFORE
		// timeout ran. Contrast ENV_VAR_PATTERN below which already allowlists.
		/^timeout[ \t]+(?:(?:--(?:foreground|preserve-status|verbose)|--(?:kill-after|signal)=[A-Za-z0-9_.+-]+|--(?:kill-after|signal)[ \t]+[A-Za-z0-9_.+-]+|-v|-[ks][ \t]+[A-Za-z0-9_.+-]+|-[ks][A-Za-z0-9_.+-]+)[ \t]+)*(?:--[ \t]+)?\d+(?:\.\d+)?[smhd]?[ \t]+/,
		/^time[ \t]+(?:--[ \t]+)?/,
		// SECURITY: keep in sync with any semantic wrapper-strip layer. Matches
		// `nice cmd`, `nice -n N cmd`, `nice -N cmd`.
		/^nice(?:[ \t]+-n[ \t]+-?\d+|[ \t]+-\d+)?[ \t]+(?:--[ \t]+)?/,
		// stdbuf: fused short flags only (-o0, -eL). We fail-closed on
		// space-separated/long forms — not over-stripping is safe.
		/^stdbuf(?:[ \t]+-[ioe][LN0-9]+)+[ \t]+(?:--[ \t]+)?/,
		/^nohup[ \t]+(?:--[ \t]+)?/,
	] as const;

	// Pattern for environment variables:
	// ^([A-Za-z_][A-Za-z0-9_]*)  - Variable name (standard identifier)
	// =                           - Equals sign
	// ([A-Za-z0-9_./:-]+)         - Value: alphanumeric + safe punctuation only
	// [ \t]+                      - Required HORIZONTAL whitespace after value
	//
	// SECURITY: Only matches unquoted values with safe characters (no $(), `, $var, ;|&).
	//
	// SECURITY: Trailing whitespace MUST be [ \t]+ (horizontal only), NOT \s+.
	// \s matches \n/\r. If an unquoted newline lands between `TZ=UTC` and
	// `echo`, \s+ would match across it and strip `TZ=UTC<NL>`, leaving
	// `echo curl evil.com` to match Bash(echo:*). But bash treats the newline
	// as a command separator.
	const ENV_VAR_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_./:-]+)[ \t]+/;

	let stripped = command;
	let previousStripped = "";

	// Phase 1: Strip leading env vars and comments only.
	// In bash, env var assignments before a command (VAR=val cmd) are genuine
	// shell-level assignments. These are safe to strip for permission matching.
	while (stripped !== previousStripped) {
		previousStripped = stripped;
		stripped = stripCommentLines(stripped);

		const envVarMatch = stripped.match(ENV_VAR_PATTERN);
		if (envVarMatch) {
			const varName = envVarMatch[1];
			const isAdvancedSafe = advancedStripEnabled() && ADVANCED_SAFE_ENV_VARS.has(varName);
			if (SAFE_ENV_VARS.has(varName) || isAdvancedSafe) {
				stripped = stripped.replace(ENV_VAR_PATTERN, "");
			}
		}
	}

	// Phase 2: Strip wrapper commands and comments only. Do NOT strip env vars.
	// Wrapper commands (timeout, time, nice, nohup) use execvp to run their
	// arguments, so VAR=val after a wrapper is treated as the COMMAND to execute,
	// not as an env var assignment. Stripping env vars here would create a
	// mismatch between what the parser sees and what actually executes.
	// (HackerOne #3543050)
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
