/**
 * Bash path-validation engine, ported from Claude Code's
 * `packages/builtin-tools/src/tools/BashTool/pathValidation.ts`.
 *
 * Per-command argv extractors identify which arguments of ~35 filesystem
 * commands are paths, a table classifies each command as read/write/create,
 * and every extracted path funnels through `core/pathValidation.validatePath`.
 * Also ported: the `--`-aware flag filter, the pattern-command (grep/rg/jq)
 * parsers, the mv/cp flag validator, the compound-cd + write gate, the
 * process-substitution gate, dangerous-removal checks, and argv-level
 * safe-wrapper stripping.
 *
 * Adaptations from Claude Code:
 * - argv comes from the host tokenizer (`tools/shell-tokenize`) instead of
 *   shell-quote/tree-sitter; redirect operators/targets are stripped from
 *   argv because the host bash-check validates redirect targets separately.
 * - wrapper stripping reuses the host `stripSafeWrappers` for env-var
 *   prefixes and ports CC's `stripWrappersFromArgv` for argv-level wrappers.
 * - working-directory asks are suppressed under `bypassPermissions` at this
 *   layer (the host decision flow would allow them at its 2a step anyway);
 *   bypass-immune `safetyCheck` and dangerous-removal asks still fire.
 * - CC's suggestion generation (read rules / addDirectories / setMode) is not
 *   ported: omp bash asks carry no suggestions.
 */

import * as os from "node:os";
import * as path from "node:path";
import { t } from "@oh-my-pi/pi-i18n";
import { tokenizeShellSegments } from "../tools/shell-tokenize";
import { stripSafeWrappers } from "./core/safeCommandStrip";
import { isDangerousRemovalPath } from "./core/pathSafety";
import {
	expandTilde,
	formatDirectoryList,
	validatePath,
	type FileOperationType,
	type PathPermissionOptions,
} from "./core/pathValidation";
import type { PermissionDecisionReason, PermissionResult } from "./core/types";

export type PathCommand =
	| "cd"
	| "ls"
	| "find"
	| "mkdir"
	| "touch"
	| "rm"
	| "rmdir"
	| "mv"
	| "cp"
	| "cat"
	| "head"
	| "tail"
	| "sort"
	| "uniq"
	| "wc"
	| "cut"
	| "paste"
	| "column"
	| "tr"
	| "file"
	| "stat"
	| "diff"
	| "awk"
	| "strings"
	| "hexdump"
	| "od"
	| "base64"
	| "nl"
	| "grep"
	| "rg"
	| "sed"
	| "git"
	| "jq"
	| "sha256sum"
	| "sha1sum"
	| "md5sum";

/**
 * SECURITY: Extract positional (non-flag) arguments, correctly handling the
 * POSIX `--` end-of-options delimiter.
 *
 * Most commands (rm, cat, touch, etc.) stop parsing options at `--` and treat
 * ALL subsequent arguments as positional, even if they start with `-`. Naive
 * `!arg.startsWith('-')` filtering drops these, causing path validation to be
 * silently skipped for attack payloads like:
 *
 *   rm -- -/../.claude/settings.local.json
 *
 * Here `-/../.claude/settings.local.json` starts with `-` so the naive filter
 * drops it, validation sees zero paths, returns passthrough, and the file is
 * deleted without a prompt. With `--` handling, the path IS extracted and
 * validated (blocked by checkPathSafetyForAutoEdit / pathInAllowedWorkingPath).
 */
function filterOutFlags(args: string[]): string[] {
	const result: string[] = [];
	let afterDoubleDash = false;
	for (const arg of args) {
		if (afterDoubleDash) {
			result.push(arg);
		} else if (arg === "--") {
			afterDoubleDash = true;
		} else if (!arg?.startsWith("-")) {
			result.push(arg);
		}
	}
	return result;
}

/** Helper: Parse grep/rg style commands (pattern then paths) */
function parsePatternCommand(args: string[], flagsWithArgs: Set<string>, defaults: string[] = []): string[] {
	const paths: string[] = [];
	let patternFound = false;
	// SECURITY: Track `--` end-of-options delimiter. After `--`, all args are
	// positional regardless of leading `-`. See filterOutFlags() doc comment.
	let afterDoubleDash = false;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === undefined || arg === null) continue;

		if (!afterDoubleDash && arg === "--") {
			afterDoubleDash = true;
			continue;
		}

		if (!afterDoubleDash && arg.startsWith("-")) {
			const flag = arg.split("=")[0];
			// Pattern flags mark that we've found the pattern
			if (flag && ["-e", "--regexp", "-f", "--file"].includes(flag)) {
				patternFound = true;
			}
			// Skip next arg if flag needs it
			if (flag && flagsWithArgs.has(flag) && !arg.includes("=")) {
				i++;
			}
			continue;
		}

		// First non-flag is pattern, rest are paths
		if (!patternFound) {
			patternFound = true;
			continue;
		}
		paths.push(arg);
	}

	return paths.length > 0 ? paths : defaults;
}

/**
 * Extracts paths from command arguments for different path commands.
 * Each command has specific logic for how it handles paths and flags.
 */
export const PATH_EXTRACTORS: Record<PathCommand, (args: string[]) => string[]> = {
	// cd: special case - all args form one path
	cd: args => (args.length === 0 ? [os.homedir()] : [args.join(" ")]),

	// ls: filter flags, default to current dir
	ls: args => {
		const paths = filterOutFlags(args);
		return paths.length > 0 ? paths : ["."];
	},

	// find: collect paths until hitting a real flag, also check path-taking flags
	// SECURITY: `find -- -path` makes `-path` a starting point (not a predicate).
	// GNU find supports `--` to allow search roots starting with `-`. After `--`,
	// we conservatively collect all remaining args as paths to validate. This
	// over-includes predicates like `-name foo`, but find is a read-only op and
	// predicates resolve to paths within cwd (allowed), so no false blocks for
	// legitimate use. The over-inclusion ensures attack paths like
	// `find -- -/../../etc` are caught.
	find: args => {
		const paths: string[] = [];
		const pathFlags = new Set([
			"-newer",
			"-anewer",
			"-cnewer",
			"-mnewer",
			"-samefile",
			"-path",
			"-wholename",
			"-ilname",
			"-lname",
			"-ipath",
			"-iwholename",
		]);
		const newerPattern = /^-newer[acmBt][acmtB]$/;
		let foundNonGlobalFlag = false;
		let afterDoubleDash = false;

		for (let i = 0; i < args.length; i++) {
			const arg = args[i];
			if (!arg) continue;

			if (afterDoubleDash) {
				paths.push(arg);
				continue;
			}

			if (arg === "--") {
				afterDoubleDash = true;
				continue;
			}

			// Handle flags
			if (arg.startsWith("-")) {
				// Global options don't stop collection
				if (["-H", "-L", "-P"].includes(arg)) continue;

				// Mark that we've seen a non-global flag
				foundNonGlobalFlag = true;

				// Check if this flag takes a path argument
				if (pathFlags.has(arg) || newerPattern.test(arg)) {
					const nextArg = args[i + 1];
					if (nextArg) {
						paths.push(nextArg);
						i++; // Skip the path we just processed
					}
				}
				continue;
			}

			// Only collect non-flag arguments before first non-global flag
			if (!foundNonGlobalFlag) {
				paths.push(arg);
			}
		}
		return paths.length > 0 ? paths : ["."];
	},

	// All simple commands: just filter out flags
	mkdir: filterOutFlags,
	touch: filterOutFlags,
	rm: filterOutFlags,
	rmdir: filterOutFlags,
	mv: filterOutFlags,
	cp: filterOutFlags,
	cat: filterOutFlags,
	head: filterOutFlags,
	tail: filterOutFlags,
	sort: filterOutFlags,
	uniq: filterOutFlags,
	wc: filterOutFlags,
	cut: filterOutFlags,
	paste: filterOutFlags,
	column: filterOutFlags,
	file: filterOutFlags,
	stat: filterOutFlags,
	diff: filterOutFlags,
	awk: filterOutFlags,
	strings: filterOutFlags,
	hexdump: filterOutFlags,
	od: filterOutFlags,
	base64: filterOutFlags,
	nl: filterOutFlags,
	sha256sum: filterOutFlags,
	sha1sum: filterOutFlags,
	md5sum: filterOutFlags,

	// tr: special case - skip character sets
	tr: args => {
		const hasDelete = args.some(a => a === "-d" || a === "--delete" || (a.startsWith("-") && a.includes("d")));
		const nonFlags = filterOutFlags(args);
		return nonFlags.slice(hasDelete ? 1 : 2); // Skip SET1 or SET1+SET2
	},

	// grep: pattern then paths, defaults to stdin
	grep: args => {
		const flags = new Set([
			"-e",
			"--regexp",
			"-f",
			"--file",
			"--exclude",
			"--include",
			"--exclude-dir",
			"--include-dir",
			"-m",
			"--max-count",
			"-A",
			"--after-context",
			"-B",
			"--before-context",
			"-C",
			"--context",
		]);
		const paths = parsePatternCommand(args, flags);
		// Special: if -r/-R flag present and no paths, use current dir
		if (paths.length === 0 && args.some(a => ["-r", "-R", "--recursive"].includes(a))) {
			return ["."];
		}
		return paths;
	},

	// rg: pattern then paths, defaults to current dir
	rg: args => {
		const flags = new Set([
			"-e",
			"--regexp",
			"-f",
			"--file",
			"-t",
			"--type",
			"-T",
			"--type-not",
			"-g",
			"--glob",
			"-m",
			"--max-count",
			"--max-depth",
			"-r",
			"--replace",
			"-A",
			"--after-context",
			"-B",
			"--before-context",
			"-C",
			"--context",
		]);
		return parsePatternCommand(args, flags, ["."]);
	},

	// sed: processes files in-place or reads from stdin
	sed: args => {
		const paths: string[] = [];
		let skipNext = false;
		let scriptFound = false;
		// SECURITY: Track `--` end-of-options delimiter. After `--`, all args are
		// positional regardless of leading `-`. See filterOutFlags() doc comment.
		let afterDoubleDash = false;

		for (let i = 0; i < args.length; i++) {
			if (skipNext) {
				skipNext = false;
				continue;
			}

			const arg = args[i];
			if (!arg) continue;

			if (!afterDoubleDash && arg === "--") {
				afterDoubleDash = true;
				continue;
			}

			// Handle flags (only before `--`)
			if (!afterDoubleDash && arg.startsWith("-")) {
				// -f flag: next arg is a script file that needs validation
				if (["-f", "--file"].includes(arg)) {
					const scriptFile = args[i + 1];
					if (scriptFile) {
						paths.push(scriptFile); // Add script file to paths for validation
						skipNext = true;
					}
					scriptFound = true;
				}
				// -e flag: next arg is expression, not a file
				else if (["-e", "--expression"].includes(arg)) {
					skipNext = true;
					scriptFound = true;
				}
				// Combined flags like -ie or -nf
				else if (arg.includes("e") || arg.includes("f")) {
					scriptFound = true;
				}
				continue;
			}

			// First non-flag is the script (if not already found via -e/-f)
			if (!scriptFound) {
				scriptFound = true;
				continue;
			}

			// Rest are file paths
			paths.push(arg);
		}

		return paths;
	},

	// jq: filter then file paths (similar to grep)
	// The jq command structure is: jq [flags] filter [files...]
	// If no files are provided, jq reads from stdin
	jq: args => {
		const paths: string[] = [];
		const flagsWithArgs = new Set([
			"-e",
			"--expression",
			"-f",
			"--from-file",
			"--arg",
			"--argjson",
			"--slurpfile",
			"--rawfile",
			"--args",
			"--jsonargs",
			"-L",
			"--library-path",
			"--indent",
			"--tab",
		]);
		let filterFound = false;
		// SECURITY: Track `--` end-of-options delimiter. After `--`, all args are
		// positional regardless of leading `-`. See filterOutFlags() doc comment.
		let afterDoubleDash = false;

		for (let i = 0; i < args.length; i++) {
			const arg = args[i];
			if (arg === undefined || arg === null) continue;

			if (!afterDoubleDash && arg === "--") {
				afterDoubleDash = true;
				continue;
			}

			if (!afterDoubleDash && arg.startsWith("-")) {
				const flag = arg.split("=")[0];
				// Pattern flags mark that we've found the filter
				if (flag && ["-e", "--expression"].includes(flag)) {
					filterFound = true;
				}
				// Skip next arg if flag needs it
				if (flag && flagsWithArgs.has(flag) && !arg.includes("=")) {
					i++;
				}
				continue;
			}

			// First non-flag is filter, rest are file paths
			if (!filterFound) {
				filterFound = true;
				continue;
			}
			paths.push(arg);
		}

		// If no file paths, jq reads from stdin (no paths to validate)
		return paths;
	},

	// git: handle subcommands that access arbitrary files outside the repository
	git: args => {
		// git diff --no-index is special - it explicitly compares files outside git's control
		// This flag allows git diff to compare any two files on the filesystem, not just
		// files within the repository, which is why it needs path validation
		if (args.length >= 1 && args[0] === "diff") {
			if (args.includes("--no-index")) {
				// SECURITY: git diff --no-index accepts `--` before file paths.
				// Use filterOutFlags which handles `--` correctly instead of naive
				// startsWith('-') filtering, to catch paths like `-/../etc/passwd`.
				const filePaths = filterOutFlags(args.slice(1));
				return filePaths.slice(0, 2); // git diff --no-index expects exactly 2 paths
			}
		}
		// Other git commands (add, rm, mv, show, etc.) operate within the repository context
		// and are already constrained by git's own security model, so they don't need
		// additional path validation
		return [];
	},
};

const ACTION_VERBS: Record<PathCommand, string> = {
	cd: "change directories to",
	ls: "list files in",
	find: "search files in",
	mkdir: "create directories in",
	touch: "create or modify files in",
	rm: "remove files from",
	rmdir: "remove directories from",
	mv: "move files to/from",
	cp: "copy files to/from",
	cat: "concatenate files from",
	head: "read the beginning of files from",
	tail: "read the end of files from",
	sort: "sort contents of files from",
	uniq: "filter duplicate lines from files in",
	wc: "count lines/words/bytes in files from",
	cut: "extract columns from files in",
	paste: "merge files from",
	column: "format files from",
	tr: "transform text from files in",
	file: "examine file types in",
	stat: "read file stats from",
	diff: "compare files from",
	awk: "process text from files in",
	strings: "extract strings from files in",
	hexdump: "display hex dump of files from",
	od: "display octal dump of files from",
	base64: "encode/decode files from",
	nl: "number lines in files from",
	grep: "search for patterns in files from",
	rg: "search for patterns in files from",
	sed: "edit files in",
	git: "access files with git from",
	jq: "process JSON from files in",
	sha256sum: "compute SHA-256 checksums for files in",
	sha1sum: "compute SHA-1 checksums for files in",
	md5sum: "compute MD5 checksums for files in",
};

export const COMMAND_OPERATION_TYPE: Record<PathCommand, FileOperationType> = {
	cd: "read",
	ls: "read",
	find: "read",
	mkdir: "create",
	touch: "create",
	rm: "write",
	rmdir: "write",
	mv: "write",
	cp: "write",
	cat: "read",
	head: "read",
	tail: "read",
	sort: "read",
	uniq: "read",
	wc: "read",
	cut: "read",
	paste: "read",
	column: "read",
	tr: "read",
	file: "read",
	stat: "read",
	diff: "read",
	awk: "read",
	strings: "read",
	hexdump: "read",
	od: "read",
	base64: "read",
	nl: "read",
	grep: "read",
	rg: "read",
	sed: "write",
	git: "read",
	jq: "read",
	sha256sum: "read",
	sha1sum: "read",
	md5sum: "read",
};

/**
 * Command-specific validators that run before path validation.
 * Returns true if the command is valid, false if it should be rejected.
 * Used to block commands with flags that could bypass path validation.
 */
const COMMAND_VALIDATOR: Partial<Record<PathCommand, (args: string[]) => boolean>> = {
	mv: (args: string[]) => !args.some(arg => arg?.startsWith("-")),
	cp: (args: string[]) => !args.some(arg => arg?.startsWith("-")),
};

// ============================================================================
// Argv-level safe-wrapper stripping (timeout, nice, stdbuf, env, time, nohup)
//
// Ported from CC's pathValidation.ts stripWrappersFromArgv: without it,
// `timeout 10 rm -rf /` would be seen as base command `timeout` and its paths
// never validated. Keep in sync with `core/safeCommandStrip.ts`
// (stripSafeWrappers), which strips the text-level subset for rule matching.
// ============================================================================

// SECURITY: allowlist for timeout flag VALUES (signals are TERM/KILL/9,
// durations are 5/5s/10.5). Rejects $ ( ) ` | ; & and newlines that
// previously matched via [^ \t]+ — `timeout -k$(id) 10 ls` must NOT strip.
const TIMEOUT_FLAG_VALUE_RE = /^[A-Za-z0-9_.+-]+$/;

/** Parse timeout's GNU flags; returns the argv index of the DURATION token, or -1 if flags are unparseable. */
function skipTimeoutFlags(a: readonly string[]): number {
	let i = 1;
	while (i < a.length) {
		const arg = a[i];
		const next = a[i + 1];
		if (arg === "--foreground" || arg === "--preserve-status" || arg === "--verbose") i++;
		else if (/^--(?:kill-after|signal)=[A-Za-z0-9_.+-]+$/.test(arg)) i++;
		else if ((arg === "--kill-after" || arg === "--signal") && next && TIMEOUT_FLAG_VALUE_RE.test(next)) i += 2;
		else if (arg === "--") {
			i++;
			break;
		} // end-of-options marker
		else if (arg.startsWith("--")) return -1;
		else if (arg === "-v") i++;
		else if ((arg === "-k" || arg === "-s") && next && TIMEOUT_FLAG_VALUE_RE.test(next)) i += 2;
		else if (/^-[ks][A-Za-z0-9_.+-]+$/.test(arg)) i++;
		else if (arg.startsWith("-")) return -1;
		else break;
	}
	return i;
}

/**
 * Parse stdbuf's flags (-i/-o/-e in fused/space-separated/long-= forms).
 * Returns argv index of wrapped COMMAND, or -1 if unparseable or no flags
 * consumed (stdbuf without flags is inert).
 */
function skipStdbufFlags(a: readonly string[]): number {
	let i = 1;
	while (i < a.length) {
		const arg = a[i];
		if (/^-[ioe]$/.test(arg) && a[i + 1]) i += 2;
		else if (/^-[ioe]./.test(arg)) i++;
		else if (/^--(input|output|error)=/.test(arg)) i++;
		else if (arg.startsWith("-"))
			return -1; // unknown flag: fail closed
		else break;
	}
	return i > 1 && i < a.length ? i : -1;
}

/**
 * Parse env's VAR=val and safe flags (-i/-0/-v/-u NAME). Returns argv index
 * of wrapped COMMAND, or -1 if unparseable/no wrapped cmd. Rejects -S (argv
 * splitter), -C/-P (altwd/altpath).
 */
function skipEnvFlags(a: readonly string[]): number {
	let i = 1;
	while (i < a.length) {
		const arg = a[i];
		if (arg.includes("=") && !arg.startsWith("-")) i++;
		else if (arg === "-i" || arg === "-0" || arg === "-v") i++;
		else if (arg === "-u" && a[i + 1]) i += 2;
		else if (arg.startsWith("-"))
			return -1; // -S/-C/-P/unknown: fail closed
		else break;
	}
	return i < a.length ? i : -1;
}

/**
 * Argv-level counterpart to stripSafeWrappers. Strips wrapper commands from a
 * token-list argv so `timeout 10 rm -rf /` validates `rm`'s paths. Env vars
 * are handled textually by stripSafeWrappers (see segmentArgv).
 */
function stripWrappersFromArgv(argv: string[]): string[] {
	let a = argv;
	for (;;) {
		if (a[0] === "time" || a[0] === "nohup") {
			a = a.slice(a[1] === "--" ? 2 : 1);
		} else if (a[0] === "timeout") {
			const i = skipTimeoutFlags(a);
			// SECURITY (CC): unrecognized duration (`.5`, `+5`, `inf` — strtod
			// formats GNU timeout accepts) → return a unchanged, failing closed.
			if (i < 0 || !a[i] || !/^\d+(?:\.\d+)?[smhd]?$/.test(a[i])) return a;
			a = a.slice(i + 1);
		} else if (a[0] === "nice") {
			// SECURITY (CC): handle bare `nice cmd` and legacy `nice -N cmd`, not
			// just `nice -n N cmd`, so `nice rm /outside` still validates /outside.
			if (a[1] === "-n" && a[2] && /^-?\d+$/.test(a[2])) a = a.slice(a[3] === "--" ? 4 : 3);
			else if (a[1] && /^-\d+$/.test(a[1])) a = a.slice(a[2] === "--" ? 3 : 2);
			else a = a.slice(a[1] === "--" ? 2 : 1);
		} else if (a[0] === "stdbuf") {
			const i = skipStdbufFlags(a);
			if (i < 0) return a;
			a = a.slice(i);
		} else if (a[0] === "env") {
			const i = skipEnvFlags(a);
			if (i < 0) return a;
			a = a.slice(i);
		} else {
			return a;
		}
	}
}

// ============================================================================
// Segment argv extraction
// ============================================================================

/**
 * Standalone redirect-operator token shapes the tokenizer emits (`>`, `>>`,
 * `>&`, `>|`, fd-prefixed `2>`/`2>&`, heredoc `<<`/`<<<`, read-write `<>`).
 */
const REDIRECT_OP_TOKEN_RE = /^\d*[<>]{1,3}[&|]?$/u;

/**
 * Drop redirect operators and their targets from a token list, mirroring CC's
 * shell-quote parse (which excludes redirect operators from argv). Output
 * operators (containing `>`) also drop the following target token — the
 * bash-check redirect scan validates those targets. Input-only operators
 * (`<`, `<<`, `<<<`) keep the next token in argv so read targets still flow
 * through path validation. Fused forms (`2>/tmp/x`, `>/tmp/x`, `>>/tmp/x`,
 * e.g. from quoted words) are dropped whole as defense in depth.
 */
function stripRedirectTokens(tokens: string[]): string[] {
	const argv: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (REDIRECT_OP_TOKEN_RE.test(token)) {
			if (token.includes(">")) i++; // operator + target are handled by the redirect scan
			continue;
		}
		const fused = /^[0-9]*>{1,2}/.exec(token);
		if (fused && fused[0].length < token.length) continue;
		argv.push(token);
	}
	return argv;
}

/**
 * Quote-stripped tokens → command argv: strip safe env-var/wrapper prefixes
 * textually (host stripSafeWrappers), otherwise strip wrappers at argv level.
 */
function segmentArgv(tokens: string[]): string[] {
	const joined = tokens.join(" ");
	const stripped = stripSafeWrappers(joined);
	if (stripped !== joined) {
		// An env-var/wrapper prefix was stripped textually; re-tokenize the
		// remainder. Quoting detail inside the remainder was already lost by the
		// first tokenization pass — acceptable for prefixed commands.
		return stripRedirectTokens(tokenizeShellSegments(stripped)[0] ?? []);
	}
	return stripRedirectTokens(stripWrappersFromArgv(tokens));
}

// ============================================================================
// Per-command validation
// ============================================================================

function blockedPathMessage(
	command: PathCommand,
	resolvedPath: string,
	decisionReason: PermissionDecisionReason | undefined,
	options: PathPermissionOptions,
): string {
	// Use security check's custom reason if available (type: 'other' or
	// 'safetyCheck'); otherwise use the standard "was blocked" message.
	if (decisionReason?.type === "other" || decisionReason?.type === "safetyCheck") {
		return decisionReason.reason;
	}
	const dirListStr = formatDirectoryList([...options.workingDirectories]);
	return t(
		"{{command}} in '{{path}}' was blocked. For security, the agent may only {{verb}} the allowed working directories for this session: {{dirs}}.",
		{ command, path: resolvedPath, verb: ACTION_VERBS[command], dirs: dirListStr },
	);
}

/**
 * CC's checkDangerousRemovalPaths: rm/rmdir targets that must always prompt,
 * even under bypassPermissions and allowlist rules. Paths are checked WITHOUT
 * resolving symlinks — dangerous paths like /tmp must be caught even though
 * /tmp symlinks to /private/tmp on macOS.
 */
function checkDangerousRemovalPaths(
	command: "rm" | "rmdir",
	args: string[],
	cwd: string,
): PermissionResult | undefined {
	const paths = PATH_EXTRACTORS[command](args);
	for (const candidate of paths) {
		const cleanPath = expandTilde(candidate.replace(/^['"]|['"]$/g, ""));
		const absolutePath = path.isAbsolute(cleanPath) ? cleanPath : path.resolve(cwd, cleanPath);
		if (isDangerousRemovalPath(absolutePath)) {
			return {
				behavior: "ask",
				message: t("Refusing to remove a dangerous path without confirmation: {{path}}.", { path: absolutePath }),
				decisionReason: {
					type: "safetyCheck",
					reason: "dangerous removal target",
					classifierApprovable: false,
				},
				blockedPath: absolutePath,
			};
		}
	}
	return undefined;
}

function validateCommandPaths(
	command: PathCommand,
	args: string[],
	cwd: string,
	options: PathPermissionOptions,
	compoundHasCd: boolean,
	operationTypeOverride?: FileOperationType,
): PermissionResult | undefined {
	const extractor = PATH_EXTRACTORS[command];
	const paths = extractor(args);
	const operationType = operationTypeOverride ?? COMMAND_OPERATION_TYPE[command];

	// SECURITY: Check command-specific validators (e.g., to block flags that
	// could bypass path validation). Some commands like mv/cp have flags
	// (--target-directory=PATH) that can bypass path extraction, so we block
	// ALL flags for these commands to ensure security.
	const validator = COMMAND_VALIDATOR[command];
	if (validator && !validator(args)) {
		if (options.mode === "bypassPermissions") return undefined;
		return {
			behavior: "ask",
			message: t(
				"{{command}} with flags requires manual approval to ensure path safety: some flags (like --target-directory=PATH) can bypass path validation.",
				{ command },
			),
			decisionReason: {
				type: "other",
				reason: `${command} command with flags requires manual approval`,
			},
		};
	}

	// SECURITY: Block write operations in compound commands containing 'cd'.
	// This prevents bypassing path safety checks via directory changes before
	// operations. Example attack: cd .claude/ && mv test.txt settings.json —
	// paths would be resolved relative to the original CWD, not accounting for
	// the cd's effect. CC deliberately takes the conservative approach of
	// requiring manual approval instead of tracking the effective CWD through
	// the command chain (relative paths, `cd ~`/`cd -`, multiple cds, error
	// cases).
	if (compoundHasCd && operationType !== "read") {
		if (options.mode === "bypassPermissions") return undefined;
		return {
			behavior: "ask",
			message: t(
				"Commands that change directories and perform write operations require explicit approval to ensure paths are evaluated correctly: the final working directory cannot be determined when 'cd' is used in compound commands.",
			),
			decisionReason: {
				type: "other",
				reason:
					"Compound command contains cd with write operation - manual approval required to prevent path resolution bypass",
			},
		};
	}

	for (const candidate of paths) {
		const { allowed, resolvedPath, decisionReason } = validatePath(candidate, cwd, options, operationType);
		if (allowed) continue;
		const message = blockedPathMessage(command, resolvedPath, decisionReason, options);

		// Deny rules win outright and survive bypassPermissions.
		if (decisionReason?.type === "rule") {
			return { behavior: "deny", message, decisionReason };
		}
		// safetyCheck asks (sensitive files/dirs) are bypass-immune (CC step 1g).
		if (decisionReason?.type === "safetyCheck") {
			return { behavior: "ask", message, blockedPath: resolvedPath, decisionReason };
		}
		// Working-dir asks are suppressible under bypassPermissions (CC 2a
		// parity: only bypass-immune safetyChecks survive bypass there).
		if (options.mode === "bypassPermissions") continue;
		return {
			behavior: "ask",
			message,
			blockedPath: resolvedPath,
			decisionReason: decisionReason ?? {
				type: "workingDir",
				reason: "Path is outside allowed working directories",
			},
		};
	}

	// All paths valid (or asks suppressed) — passthrough.
	return undefined;
}

const SED_PRINT_COMMAND_RE = /^(?:\d+|\d+,\d+)?p$/;
const SED_READ_LONG_FLAGS = new Set(["--quiet", "--silent", "--regexp-extended", "--zero-terminated", "--posix"]);
const SED_READ_SHORT_FLAG_CHARS = new Set(["n", "E", "r", "z"]);

/**
 * Token-level adaptation of CC's sedValidation isLinePrintingCommand: a
 * strictly line-printing `sed -n 'Np;Mp'` invocation only reads its file
 * arguments, so they validate as reads instead of writes.
 */
function sedLinePrintOnly(args: string[]): boolean {
	let hasN = false;
	let script: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (script === undefined && arg.startsWith("-")) {
			if (arg === "--") {
				script = args[i + 1];
				break;
			}
			if (arg.startsWith("--")) {
				if (!SED_READ_LONG_FLAGS.has(arg)) return false;
				if (arg === "--quiet" || arg === "--silent") hasN = true;
				continue;
			}
			// Short or combined flags like -nE: every char must be allowlisted.
			for (const ch of arg.slice(1)) {
				if (ch === "n") hasN = true;
				else if (!SED_READ_SHORT_FLAG_CHARS.has(ch)) return false;
			}
			continue;
		}
		script = arg;
		break;
	}
	if (!hasN || script === undefined) return false;
	return script.split(";").every(part => SED_PRINT_COMMAND_RE.test(part.trim()));
}

/**
 * Validate one command segment (quote-stripped tokens from the host
 * tokenizer) against the path-command engine. Returns an ask/deny result, or
 * undefined when the segment is not a path command or all its paths validate.
 */
export function validateSegmentCommandPaths(
	tokens: string[],
	cwd: string,
	options: PathPermissionOptions,
	compoundHasCd: boolean,
): PermissionResult | undefined {
	const argv = segmentArgv(tokens);
	if (argv.length === 0) return undefined;
	const [baseCmd, ...args] = argv;
	if (!baseCmd || !(baseCmd in PATH_EXTRACTORS)) return undefined;
	const command = baseCmd as PathCommand;

	// Read-only sed (line printing) reads its file arguments instead of
	// writing them; everything else keeps the table's operation type.
	const operationTypeOverride = command === "sed" && sedLinePrintOnly(args) ? "read" : undefined;

	// First check normal path validation (which includes explicit deny rules).
	const result = validateCommandPaths(command, args, cwd, options, compoundHasCd, operationTypeOverride);

	// If explicitly denied, respect that (don't override with dangerous path message).
	if (result?.behavior === "deny") return result;

	// Check dangerous removal paths AFTER explicit deny rules but BEFORE other
	// results, so the check runs even under allowlist rules and its specific
	// message overrides the generic working-directory ask.
	if (command === "rm" || command === "rmdir") {
		const dangerous = checkDangerousRemovalPaths(command, args, cwd);
		if (dangerous) return dangerous;
	}

	return result;
}

// ============================================================================
// Process substitution
// ============================================================================

const PROCESS_SUBSTITUTION_RE = />>\s*>\s*\(|>\s*>\s*\(|<\s*\(/;

/**
 * SECURITY: Process substitution >(cmd) can execute commands that write to
 * files without those files appearing as redirect targets. For example:
 *
 *   echo secret > >(tee .git/config)
 *
 * The tee command writes to .git/config but it's not detected as a redirect.
 * Require explicit approval for any command containing process substitution.
 * The host bash-security scan catches unquoted forms earlier (quote-aware);
 * this raw-text gate is the CC-ported backstop.
 */
export function checkProcessSubstitution(command: string): PermissionResult | undefined {
	if (!PROCESS_SUBSTITUTION_RE.test(command)) return undefined;
	return {
		behavior: "ask",
		message: t(
			"Process substitution (>(...) or <(...)) can execute arbitrary commands and requires manual approval.",
		),
		decisionReason: {
			type: "other",
			reason: "Process substitution requires manual approval",
		},
	};
}
