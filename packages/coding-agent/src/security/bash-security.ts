/**
 * Bash injection heuristic checker, ported from Claude Code's
 * `packages/builtin-tools/src/tools/BashTool/bashSecurity.ts`
 * (the synchronous pure-regex path: `bashCommandIsSafe_DEPRECATED` plus all of
 * its validators and quote-handling helpers).
 *
 * Ported alongside its dependencies:
 * - `src/utils/bash/heredoc.ts` (`extractHeredocs`, quotedOnly mode)
 * - `src/utils/bash/shellQuote.ts` (`hasShellQuoteSingleQuoteBug`,
 *   `tryParseShellCommand`, `hasMalformedTokens`) — since npm `shell-quote`
 *   is not a dependency here, its `parse` is inlined as a faithful port
 *   (shell-quote 1.8.3, empty-env semantics matching CC's call site).
 *
 * Dropped from the source:
 * - analytics (`logEvent` / `tengu_*` events and check IDs)
 * - the tree-sitter/async path (`bashCommandIsSafeAsync_DEPRECATED`,
 *   `getTreeSitterAnalysis`, `parseForSecurityFromAst`) and the
 *   `treeSitter` branches in validators
 * - feature flags and `USER_TYPE === 'ant'` branches
 * - `updatedInput` / `decisionReason` fields (folded into `message`)
 *
 * The evaluation order, early-allow mapping (allow → passthrough),
 * `isBashSecurityCheckForMisparsing` tagging and the deferred non-misparsing
 * return for `validateNewlines` / `validateRedirections` are preserved exactly.
 */

import { randomBytes } from "node:crypto";

export type BashSafetyResult = {
	behavior: "allow" | "ask" | "passthrough";
	message?: string;
	isBashSecurityCheckForMisparsing?: boolean;
};

type Validator = (context: ValidationContext) => BashSafetyResult;

type ValidationContext = {
	originalCommand: string;
	baseCommand: string;
	unquotedContent: string;
	fullyUnquotedContent: string;
	/** fullyUnquoted before stripSafeRedirections — used by validateBraceExpansion
	 * and validateNewlines to avoid false negatives from redirection stripping
	 * creating backslash adjacencies */
	fullyUnquotedPreStrip: string;
	/** Like fullyUnquotedPreStrip but preserves quote characters ('/"): e.g.,
	 * echo 'x'# → echo ''# (the quote chars remain, revealing adjacency to #) */
	unquotedKeepQuoteChars: string;
};

// ============================================================================
// Shared patterns
// ============================================================================

const HEREDOC_IN_SUBSTITUTION = /\$\(.*<</;

// Backticks are handled separately via hasUnescapedChar to distinguish escaped
// from unescaped occurrences.
const COMMAND_SUBSTITUTION_PATTERNS = [
	{ pattern: /<\(/, message: "process substitution <()" },
	{ pattern: />\(/, message: "process substitution >()" },
	{ pattern: /=\(/, message: "Zsh process substitution =()" },
	// Zsh EQUALS expansion: word-initial =cmd expands to $(which cmd), hiding
	// the real command name from prefix rules — but not VAR=val assignments.
	{
		pattern: /(?:^|[\s;&|])=[a-zA-Z_]/,
		message: "Zsh equals expansion (=cmd)",
	},
	{ pattern: /\$\(/, message: "$() command substitution" },
	{ pattern: /\$\{/, message: "${} parameter substitution" },
	{ pattern: /\$\[/, message: "$[] legacy arithmetic expansion" },
	{ pattern: /~\[/, message: "Zsh-style parameter expansion" },
	{ pattern: /\(e:/, message: "Zsh-style glob qualifiers" },
	{ pattern: /\(\+/, message: "Zsh glob qualifier with command execution" },
	{
		pattern: /\}\s*always\s*\{/,
		message: "Zsh always block (try/always construct)",
	},
	{ pattern: /<#/, message: "PowerShell comment syntax" },
];

const ZSH_DANGEROUS_COMMANDS = new Set([
	"zmodload",
	"emulate",
	"sysopen",
	"sysread",
	"syswrite",
	"sysseek",
	"zpty",
	"ztcp",
	"zsocket",
	"mapfile",
	"zf_rm",
	"zf_mv",
	"zf_ln",
	"zf_chmod",
	"zf_chown",
	"zf_mkdir",
	"zf_rmdir",
	"zf_chgrp",
]);

// `(`/`)` are excluded on purpose: splitCommand round-trips `\(` and `\)`,
// so they never trigger the double-parse bug that `\<op>` does.
const SHELL_OPERATORS = new Set([";", "|", "&", "<", ">"]);

const UNICODE_WS_RE = /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]/;

const NETWORK_DEVICE_PATH_RE = /\/dev\/(tcp|udp)\/[^/\s"'`$]+\/\d+/i;

const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

// ============================================================================
// shell-quote port (parse + malformed-token detection)
// ============================================================================

type ShellToken = string | { op: string; pattern?: string } | { comment: string };

type ShellParseResult = { success: true; tokens: ShellToken[] } | { success: false; error: string };

const SH_CONTROL_SOURCE =
	"(?:\\|\\||\\&\\&|;;|\\|\\&|\\<\\(|\\<\\<\\<|>>|>\\&|<\\&|[&;()|<>])";
const SH_CONTROL_RE = new RegExp(`^${SH_CONTROL_SOURCE}$`);
const SH_META = "|&;()<> \\t";
const SH_BAREWORD_SOURCE = `(\\\\['"${SH_META}]|[^\\s'"${SH_META}])+`;
const SH_DOUBLE_QUOTE_SOURCE = `"((\\\\\\"|[^\"])*?)"`;
const SH_SINGLE_QUOTE_SOURCE = `'((\\\\'|[^'])*?)'`;

function matchAllRegex(s: string, r: RegExp): RegExpExecArray[] {
	const origIndex = r.lastIndex;
	const matches: RegExpExecArray[] = [];
	let matchObj: RegExpExecArray | null;
	while ((matchObj = r.exec(s)) !== null) {
		matches.push(matchObj);
		if (r.lastIndex === matchObj.index) {
			r.lastIndex += 1;
		}
	}
	r.lastIndex = origIndex;
	return matches;
}

/** shell-quote's getVar with a fixed empty env: unset named vars expand to "". */
function getEmptyEnvVarValue(key: string): string {
	return key === "" ? "$" : "";
}

function parseShellCommandTokens(command: string): ShellToken[] {
	const chunker = new RegExp(
		`(${SH_CONTROL_SOURCE})|((${SH_BAREWORD_SOURCE}|${SH_DOUBLE_QUOTE_SOURCE}|${SH_SINGLE_QUOTE_SOURCE})+)`,
		"g",
	);
	const matches = matchAllRegex(command, chunker);
	if (matches.length === 0) {
		return [];
	}

	let commented = false;

	const mapped: (ShellToken | ShellToken[] | undefined)[] = matches.map((match) => {
		const s = match[0];
		if (!s || commented) {
			return undefined;
		}
		if (SH_CONTROL_RE.test(s)) {
			return { op: s };
		}

		// Bash quoting scanner: inside single quotes everything is literal;
		// inside double quotes only \" \\ \$ are escapes and $VAR expands;
		// outside quotes backslash escapes the next char; quote contexts can
		// switch mid-token (all'one'"token" → allonetoken).
		let quote: string | false = false;
		let esc = false;
		let out = "";
		let isGlob = false;
		let i = 0;

		const parseEnvVar = (): string => {
			i += 1;
			const char = s.charAt(i);
			let varname: string;
			if (char === "{") {
				i += 1;
				if (s.charAt(i) === "}") {
					throw new Error(`Bad substitution: ${s.slice(i - 2, i + 1)}`);
				}
				const varend = s.indexOf("}", i);
				if (varend < 0) {
					throw new Error(`Bad substitution: ${s.slice(i)}`);
				}
				varname = s.slice(i, varend);
				i = varend;
			} else if (/[*@#?$!_-]/.test(char)) {
				varname = char;
				i += 1;
			} else {
				const slicedFromI = s.slice(i);
				const varend = slicedFromI.match(/[^\w\d_]/);
				if (!varend) {
					varname = slicedFromI;
					i = s.length;
				} else {
					varname = slicedFromI.slice(0, varend.index);
					i += varend.index - 1;
				}
			}
			return getEmptyEnvVarValue(varname);
		};

		for (i = 0; i < s.length; i++) {
			const c = s.charAt(i);
			isGlob = isGlob || (!quote && (c === "*" || c === "?"));
			if (esc) {
				out += c;
				esc = false;
			} else if (quote) {
				if (c === quote) {
					quote = false;
				} else if (quote === "'") {
					out += c;
				} else if (c === "\\") {
					i += 1;
					const escaped = s.charAt(i);
					if (escaped === '"' || escaped === "\\" || escaped === "$") {
						out += escaped;
					} else {
						out += `\\${escaped}`;
					}
				} else if (c === "$") {
					out += parseEnvVar();
				} else {
					out += c;
				}
			} else if (c === '"' || c === "'") {
				quote = c;
			} else if (SH_CONTROL_RE.test(c)) {
				return { op: s };
			} else if (c === "#") {
				commented = true;
				const commentObj = { comment: command.slice(match.index + i + 1) };
				if (out.length) {
					return [out, commentObj];
				}
				return [commentObj];
			} else if (c === "\\") {
				esc = true;
			} else if (c === "$") {
				out += parseEnvVar();
			} else {
				out += c;
			}
		}

		if (isGlob) {
			return { op: "glob", pattern: out };
		}

		return out;
	});

	const tokens: ShellToken[] = [];
	for (const entry of mapped) {
		if (entry === undefined) {
			continue;
		}
		if (Array.isArray(entry)) {
			tokens.push(...entry);
		} else {
			tokens.push(entry);
		}
	}
	return tokens;
}

function tryParseShellCommand(command: string): ShellParseResult {
	try {
		return { success: true, tokens: parseShellCommandTokens(command) };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown parse error",
		};
	}
}

/**
 * Detects malformed tokens (unbalanced delimiters / quote parity) that suggest
 * shell-quote misinterpreted the command. Quote parity is checked on the raw
 * command because shell-quote silently drops an unmatched quote.
 */
function hasMalformedTokens(command: string, parsed: ShellToken[]): boolean {
	let inSingle = false;
	let inDouble = false;
	let doubleCount = 0;
	let singleCount = 0;
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (c === "\\" && !inSingle) {
			i++;
			continue;
		}
		if (c === '"' && !inSingle) {
			doubleCount++;
			inDouble = !inDouble;
		} else if (c === "'" && !inDouble) {
			singleCount++;
			inSingle = !inSingle;
		}
	}
	if (doubleCount % 2 !== 0 || singleCount % 2 !== 0) return true;

	for (const entry of parsed) {
		if (typeof entry !== "string") continue;

		const openBraces = (entry.match(/{/g) ?? []).length;
		const closeBraces = (entry.match(/}/g) ?? []).length;
		if (openBraces !== closeBraces) return true;

		const openParens = (entry.match(/\(/g) ?? []).length;
		const closeParens = (entry.match(/\)/g) ?? []).length;
		if (openParens !== closeParens) return true;

		const openBrackets = (entry.match(/\[/g) ?? []).length;
		const closeBrackets = (entry.match(/\]/g) ?? []).length;
		if (openBrackets !== closeBrackets) return true;

		const doubleQuotes = entry.match(/(?<!\\)"/g) ?? [];
		if (doubleQuotes.length % 2 !== 0) return true;

		const singleQuotes = entry.match(/(?<!\\)'/g) ?? [];
		if (singleQuotes.length % 2 !== 0) return true;
	}
	return false;
}

/**
 * Detects '\' patterns exploiting shell-quote's incorrect handling of
 * backslashes inside single quotes: bash treats them as literal, shell-quote
 * as escapes, so tokens merge and hide payloads from security checks.
 */
function hasShellQuoteSingleQuoteBug(command: string): boolean {
	let inSingleQuote = false;
	let inDoubleQuote = false;

	for (let i = 0; i < command.length; i++) {
		const char = command[i];

		if (char === "\\" && !inSingleQuote) {
			i++;
			continue;
		}

		if (char === '"' && !inSingleQuote) {
			inDoubleQuote = !inDoubleQuote;
			continue;
		}

		if (char === "'" && !inDoubleQuote) {
			inSingleQuote = !inSingleQuote;

			if (!inSingleQuote) {
				let backslashCount = 0;
				let j = i - 1;
				while (j >= 0 && command[j] === "\\") {
					backslashCount++;
					j--;
				}
				// Odd trailing backslashes always desync shell-quote; even ones do
				// too when a later ' exists for its chunker regex to consume.
				if (backslashCount > 0 && backslashCount % 2 === 1) {
					return true;
				}
				if (backslashCount > 0 && backslashCount % 2 === 0 && command.indexOf("'", i + 1) !== -1) {
					return true;
				}
			}
		}
	}

	return false;
}

// ============================================================================
// Heredoc extraction (quotedOnly mode of CC's src/utils/bash/heredoc.ts)
// ============================================================================

// Lookbehind/lookahead exclude <<<< sequences; [ \t] (not \s) keeps the
// delimiter word on the same line as <<.
const HEREDOC_START_PATTERN = /(?<!<)<<(?!<)(-)?[ \t]*(?:(['"])(\\?\w+)\2|\\?(\w+))/;

type HeredocInfo = {
	operatorStartIndex: number;
	operatorEndIndex: number;
	contentStartIndex: number;
	contentEndIndex: number;
};

const HEREDOC_PLACEHOLDER_PREFIX = "__HEREDOC_";
const HEREDOC_PLACEHOLDER_SUFFIX = "__";

/**
 * Replaces quoted/escaped-delimiter heredocs (<<'EOF', <<\EOF, <<"EOF") with
 * placeholders and strips their bodies. Unquoted heredoc bodies expand at
 * runtime, so they are left visible to the validators (and their ranges block
 * extraction of anything nested inside). When parsing bails, the raw command
 * goes through all validators unchanged — the safe direction.
 */
function extractHeredocs(command: string, options?: { quotedOnly?: boolean }): { processedCommand: string } {
	if (!command.includes("<<")) {
		return { processedCommand: command };
	}

	// ANSI-C/locale quoting ($'...' / $"...") and pre-<< backticks desync the
	// simplified quote scanner — bail instead of risking wrong heredoc bounds.
	if (/\$['"]/.test(command)) {
		return { processedCommand: command };
	}
	const firstHeredocPos = command.indexOf("<<");
	if (firstHeredocPos > 0 && command.slice(0, firstHeredocPos).includes("`")) {
		return { processedCommand: command };
	}

	// `((` without matching `))` before << means << may be a bit-shift, not a
	// heredoc operator; mis-extraction would hide subsequent lines.
	if (firstHeredocPos > 0) {
		const beforeHeredoc = command.slice(0, firstHeredocPos);
		const openArith = (beforeHeredoc.match(/\(\(/g) ?? []).length;
		const closeArith = (beforeHeredoc.match(/\)\)/g) ?? []).length;
		if (openArith > closeArith) {
			return { processedCommand: command };
		}
	}

	const heredocStartPattern = new RegExp(HEREDOC_START_PATTERN.source, "g");

	const heredocMatches: HeredocInfo[] = [];
	const skippedHeredocRanges: Array<{ contentStartIndex: number; contentEndIndex: number }> = [];
	let match: RegExpExecArray | null;

	// Incremental quote/comment scanner; quote tracking is comment-blind (a `#`
	// only ever causes skips, never extra extractions).
	let scanPos = 0;
	let scanInSingleQuote = false;
	let scanInDoubleQuote = false;
	let scanInComment = false;
	let scanDqEscapeNext = false;
	let scanPendingBackslashes = 0;

	const advanceScan = (target: number): void => {
		for (let i = scanPos; i < target; i++) {
			const ch = command[i];

			if (ch === "\n") scanInComment = false;

			if (scanInSingleQuote) {
				if (ch === "'") scanInSingleQuote = false;
				continue;
			}

			if (scanInDoubleQuote) {
				if (scanDqEscapeNext) {
					scanDqEscapeNext = false;
					continue;
				}
				if (ch === "\\") {
					scanDqEscapeNext = true;
					continue;
				}
				if (ch === '"') scanInDoubleQuote = false;
				continue;
			}

			if (ch === "\\") {
				scanPendingBackslashes++;
				continue;
			}
			const escaped = scanPendingBackslashes % 2 === 1;
			scanPendingBackslashes = 0;
			if (escaped) continue;

			if (ch === "'") scanInSingleQuote = true;
			else if (ch === '"') scanInDoubleQuote = true;
			else if (!scanInComment && ch === "#") scanInComment = true;
		}
		scanPos = target;
	};

	while ((match = heredocStartPattern.exec(command)) !== null) {
		const startIndex = match.index;

		advanceScan(startIndex);

		if (scanInSingleQuote || scanInDoubleQuote) {
			continue;
		}

		if (scanInComment) {
			continue;
		}

		if (scanPendingBackslashes % 2 === 1) {
			continue;
		}

		let insideSkipped = false;
		for (const skipped of skippedHeredocRanges) {
			if (startIndex > skipped.contentStartIndex && startIndex < skipped.contentEndIndex) {
				insideSkipped = true;
				break;
			}
		}
		if (insideSkipped) {
			continue;
		}

		const fullMatch = match[0];
		const isDash = match[1] === "-";
		// Group 3 = quoted delimiter (may include backslash), group 4 = unquoted
		const delimiter = match[3] || match[4];
		const operatorEndIndex = startIndex + fullMatch.length;

		// A captured quote must be the last char of the match, else \w+ stopped
		// early (e.g. <<"EO F") and the captured delimiter is not bash's.
		const quoteChar = match[2];
		if (quoteChar && command[operatorEndIndex - 1] !== quoteChar) {
			continue;
		}

		const isEscapedDelimiter = fullMatch.includes("\\");
		const isQuotedOrEscaped = Boolean(quoteChar) || isEscapedDelimiter;

		// The bash word must end here: only real metacharacters (not \s, which
		// matches \r and unicode whitespace bash treats as word chars) may follow.
		if (operatorEndIndex < command.length) {
			const nextChar = command[operatorEndIndex];
			if (!/^[ \t\n|&;()<>]$/.test(nextChar)) {
				continue;
			}
		}

		// Heredoc body starts at the first newline of the LOGICAL line — quoted
		// newlines extend it, so scan with quote state, not a blind indexOf.
		let firstNewlineOffset = -1;
		{
			let inSingleQuote = false;
			let inDoubleQuote = false;
			for (let k = operatorEndIndex; k < command.length; k++) {
				const ch = command[k];
				if (inSingleQuote) {
					if (ch === "'") inSingleQuote = false;
					continue;
				}
				if (inDoubleQuote) {
					if (ch === "\\") {
						k++;
						continue;
					}
					if (ch === '"') inDoubleQuote = false;
					continue;
				}
				if (ch === "\n") {
					firstNewlineOffset = k - operatorEndIndex;
					break;
				}
				let backslashCount = 0;
				for (let j = k - 1; j >= operatorEndIndex && command[j] === "\\"; j--) {
					backslashCount++;
				}
				if (backslashCount % 2 === 1) continue;
				if (ch === "'") inSingleQuote = true;
				else if (ch === '"') inDoubleQuote = true;
			}
		}

		if (firstNewlineOffset === -1) {
			continue;
		}

		// Odd trailing backslashes on the open line mean `\<newline>` continuation
		// joining; extraction runs before joining, so bail rather than misparse.
		const sameLineContent = command.slice(operatorEndIndex, operatorEndIndex + firstNewlineOffset);
		let trailingBackslashes = 0;
		for (let j = sameLineContent.length - 1; j >= 0; j--) {
			if (sameLineContent[j] === "\\") {
				trailingBackslashes++;
			} else {
				break;
			}
		}
		if (trailingBackslashes % 2 === 1) {
			continue;
		}

		const contentStartIndex = operatorEndIndex + firstNewlineOffset;
		const afterNewline = command.slice(contentStartIndex + 1);
		const contentLines = afterNewline.split("\n");

		// The closing delimiter must be the FIRST exact-match line; a line that
		// merely starts with the delimiter followed by a substitution closer
		// (PST_EOFTOKEN early closure) bails instead of guessing bounds.
		let closingLineIndex = -1;
		for (let i = 0; i < contentLines.length; i++) {
			const line = contentLines[i];

			if (isDash) {
				// <<- strips leading tabs only, per bash spec
				const stripped = line.replace(/^\t*/, "");
				if (stripped === delimiter) {
					closingLineIndex = i;
					break;
				}
			} else {
				if (line === delimiter) {
					closingLineIndex = i;
					break;
				}
			}

			const eofCheckLine = isDash ? line.replace(/^\t*/, "") : line;
			if (eofCheckLine.length > delimiter.length && eofCheckLine.startsWith(delimiter)) {
				const charAfterDelimiter = eofCheckLine[delimiter.length];
				if (/^[)}`|&;(<>]$/.test(charAfterDelimiter)) {
					closingLineIndex = -1;
					break;
				}
			}
		}

		// In quotedOnly mode, record unquoted heredoc bodies as skipped ranges so
		// quoted "heredocs" nested inside them are rejected (their $(...) would
		// actually expand in bash). Done before the closingLineIndex check: an
		// unclosed unquoted heredoc swallows everything to end-of-input.
		if (options?.quotedOnly && !isQuotedOrEscaped) {
			let skipContentEndIndex: number;
			if (closingLineIndex === -1) {
				skipContentEndIndex = command.length;
			} else {
				const skipLinesUpToClosing = contentLines.slice(0, closingLineIndex + 1);
				const skipContentLength = skipLinesUpToClosing.join("\n").length;
				skipContentEndIndex = contentStartIndex + 1 + skipContentLength;
			}
			skippedHeredocRanges.push({
				contentStartIndex,
				contentEndIndex: skipContentEndIndex,
			});
			continue;
		}

		if (closingLineIndex === -1) {
			continue;
		}

		const linesUpToClosing = contentLines.slice(0, closingLineIndex + 1);
		const contentLength = linesUpToClosing.join("\n").length;
		const contentEndIndex = contentStartIndex + 1 + contentLength;

		// Two heredocs sharing one command line compute bodies sequentially;
		// overlap with a skipped body means our quoted body is bogus.
		let overlapsSkipped = false;
		for (const skipped of skippedHeredocRanges) {
			if (contentStartIndex < skipped.contentEndIndex && skipped.contentStartIndex < contentEndIndex) {
				overlapsSkipped = true;
				break;
			}
		}
		if (overlapsSkipped) {
			continue;
		}

		heredocMatches.push({
			operatorStartIndex: startIndex,
			operatorEndIndex,
			contentStartIndex,
			contentEndIndex,
		});
	}

	if (heredocMatches.length === 0) {
		return { processedCommand: command };
	}

	// Drop heredocs whose operator sits inside another heredoc's content range.
	const topLevelHeredocs = heredocMatches.filter((candidate) => {
		for (const other of heredocMatches) {
			if (candidate === other) continue;
			if (candidate.operatorStartIndex > other.contentStartIndex && candidate.operatorStartIndex < other.contentEndIndex) {
				return false;
			}
		}
		return true;
	});

	if (topLevelHeredocs.length === 0) {
		return { processedCommand: command };
	}

	// Shared content start (multiple heredocs on one line) corrupts index-based
	// replacement — bail out entirely.
	const contentStartPositions = new Set(topLevelHeredocs.map((h) => h.contentStartIndex));
	if (contentStartPositions.size < topLevelHeredocs.length) {
		return { processedCommand: command };
	}

	topLevelHeredocs.sort((a, b) => b.contentEndIndex - a.contentEndIndex);

	const salt = randomBytes(8).toString("hex");

	let processedCommand = command;
	topLevelHeredocs.forEach((info, index) => {
		const placeholderIndex = topLevelHeredocs.length - 1 - index;
		const placeholder = `${HEREDOC_PLACEHOLDER_PREFIX}${placeholderIndex}_${salt}${HEREDOC_PLACEHOLDER_SUFFIX}`;

		processedCommand =
			processedCommand.slice(0, info.operatorStartIndex) +
			placeholder +
			processedCommand.slice(info.operatorEndIndex, info.contentStartIndex) +
			processedCommand.slice(info.contentEndIndex);
	});

	return { processedCommand };
}

// ============================================================================
// Quote content extraction
// ============================================================================

type QuoteExtraction = {
	withDoubleQuotes: string;
	fullyUnquoted: string;
	unquotedKeepQuoteChars: string;
};

function extractQuotedContent(command: string, isJq = false): QuoteExtraction {
	let withDoubleQuotes = "";
	let fullyUnquoted = "";
	let unquotedKeepQuoteChars = "";
	let inSingleQuote = false;
	let inDoubleQuote = false;
	let escaped = false;

	for (let i = 0; i < command.length; i++) {
		const char = command[i];

		if (escaped) {
			escaped = false;
			if (!inSingleQuote) withDoubleQuotes += char;
			if (!inSingleQuote && !inDoubleQuote) fullyUnquoted += char;
			if (!inSingleQuote && !inDoubleQuote) unquotedKeepQuoteChars += char;
			continue;
		}

		if (char === "\\" && !inSingleQuote) {
			escaped = true;
			if (!inSingleQuote) withDoubleQuotes += char;
			if (!inSingleQuote && !inDoubleQuote) fullyUnquoted += char;
			if (!inSingleQuote && !inDoubleQuote) unquotedKeepQuoteChars += char;
			continue;
		}

		if (char === "'" && !inDoubleQuote) {
			inSingleQuote = !inSingleQuote;
			unquotedKeepQuoteChars += char;
			continue;
		}

		if (char === '"' && !inSingleQuote) {
			inDoubleQuote = !inDoubleQuote;
			unquotedKeepQuoteChars += char;
			// For jq, include quotes in extraction to ensure content is properly analyzed
			if (!isJq) continue;
		}

		if (!inSingleQuote) withDoubleQuotes += char;
		if (!inSingleQuote && !inDoubleQuote) fullyUnquoted += char;
		if (!inSingleQuote && !inDoubleQuote) unquotedKeepQuoteChars += char;
	}

	return { withDoubleQuotes, fullyUnquoted, unquotedKeepQuoteChars };
}

function stripSafeRedirections(content: string): string {
	// Trailing boundary (?=\s|$) is load-bearing: without it `> /dev/nullo`
	// matches as a prefix and the leftover `o` hides the redirect.
	return content
		.replace(/\s+2\s*>&\s*1(?=\s|$)/g, "")
		.replace(/[012]?\s*>\s*\/dev\/null(?=\s|$)/g, "")
		.replace(/\s*<\s*\/dev\/null(?=\s|$)/g, "");
}

/**
 * Checks if content contains an unescaped occurrence of a single character.
 * Handles bash escape sequences where a backslash escapes the next character.
 */
function hasUnescapedChar(content: string, char: string): boolean {
	if (char.length !== 1) {
		throw new Error("hasUnescapedChar only works with single characters");
	}

	let i = 0;
	while (i < content.length) {
		if (content[i] === "\\" && i + 1 < content.length) {
			i += 2;
			continue;
		}

		if (content[i] === char) {
			return true;
		}

		i++;
	}

	return false;
}

// ============================================================================
// Early validators (allow short-circuits; ask gains the misparsing tag)
// ============================================================================

function validateEmpty(context: ValidationContext): BashSafetyResult {
	if (!context.originalCommand.trim()) {
		return { behavior: "allow", message: "Empty command is safe" };
	}
	return { behavior: "passthrough", message: "Command is not empty" };
}

function validateIncompleteCommands(context: ValidationContext): BashSafetyResult {
	const { originalCommand } = context;
	const trimmed = originalCommand.trim();

	if (/^\s*\t/.test(originalCommand)) {
		return {
			behavior: "ask",
			message: "Command appears to be an incomplete fragment (starts with tab)",
		};
	}

	if (trimmed.startsWith("-")) {
		return {
			behavior: "ask",
			message: "Command appears to be an incomplete fragment (starts with flags)",
		};
	}

	if (/^\s*(&&|\|\||;|>>?|<)/.test(originalCommand)) {
		return {
			behavior: "ask",
			message: "Command appears to be a continuation line (starts with operator)",
		};
	}

	return { behavior: "passthrough", message: "Command appears complete" };
}

/**
 * Recognizes the single early-allowable $() form:
 *   [prefix] $(cat <<'DELIM'\n body \n DELIM\n ) [suffix]
 * with a quoted/escaped delimiter, a first-line closing delimiter, and a
 * command word before the $(. Line-based matching replicates bash exactly;
 * anything else falls through to the full validator chain.
 */
function isSafeHeredoc(command: string): boolean {
	if (!HEREDOC_IN_SUBSTITUTION.test(command)) return false;

	const heredocPattern = /\$\(cat[ \t]*<<(-?)[ \t]*(?:'+([A-Za-z_]\w*)'+|\\([A-Za-z_]\w*))/g;
	let match: RegExpExecArray | null;
	type HeredocMatch = {
		start: number;
		operatorEnd: number;
		delimiter: string;
		isDash: boolean;
	};
	const safeHeredocs: HeredocMatch[] = [];
	while ((match = heredocPattern.exec(command)) !== null) {
		const delimiter = match[2] || match[3];
		if (delimiter) {
			safeHeredocs.push({
				start: match.index,
				operatorEnd: match.index + match[0].length,
				delimiter,
				isDash: match[1] === "-",
			});
		}
	}

	if (safeHeredocs.length === 0) {
		return false;
	}

	type VerifiedHeredoc = { start: number; end: number };
	const verified: VerifiedHeredoc[] = [];

	for (const { start, operatorEnd, delimiter, isDash } of safeHeredocs) {
		// Only horizontal whitespace may follow the delimiter on the open line
		const afterOperator = command.slice(operatorEnd);
		const openLineEnd = afterOperator.indexOf("\n");
		if (openLineEnd === -1) return false;
		const openLineTail = afterOperator.slice(0, openLineEnd);
		if (!/^[ \t]*$/.test(openLineTail)) return false;

		const bodyStart = operatorEnd + openLineEnd + 1;
		const body = command.slice(bodyStart);
		const bodyLines = body.split("\n");

		let closingLineIdx = -1;
		let closeParenLineIdx = -1;
		let closeParenColIdx = -1;

		for (let i = 0; i < bodyLines.length; i++) {
			const rawLine = bodyLines[i];
			const line = isDash ? rawLine.replace(/^\t*/, "") : rawLine;

			// Form 1: delimiter alone on a line, `)` first token of the next line
			if (line === delimiter) {
				closingLineIdx = i;
				if (i + 1 >= bodyLines.length) return false;
				const nextLine = bodyLines[i + 1];
				const parenMatch = nextLine.match(/^([ \t]*)\)/);
				if (!parenMatch) return false;
				closeParenLineIdx = i + 1;
				closeParenColIdx = parenMatch[1].length;
				break;
			}

			// Form 2: delimiter immediately followed by `)` (inline PST_EOFTOKEN form)
			if (line.startsWith(delimiter)) {
				const afterDelim = line.slice(delimiter.length);
				const parenMatch = afterDelim.match(/^([ \t]*)\)/);
				if (parenMatch) {
					closingLineIdx = i;
					closeParenLineIdx = i;
					const tabPrefix = isDash ? (rawLine.match(/^\t*/)?.[0] ?? "") : "";
					closeParenColIdx = tabPrefix.length + delimiter.length + parenMatch[1].length;
					break;
				}
				if (/^[)}`|&;(<>]/.test(afterDelim)) {
					return false;
				}
			}
		}

		if (closingLineIdx === -1) return false;

		let endPos = bodyStart;
		for (let i = 0; i < closeParenLineIdx; i++) {
			endPos += bodyLines[i].length + 1;
		}
		endPos += closeParenColIdx + 1;

		verified.push({ start, end: endPos });
	}

	// Nested $(cat <<'B' inside a quoted-delimiter heredoc body is literal text;
	// stripping nested ranges corrupts indices and can silently drop suffixes.
	for (const outer of verified) {
		for (const inner of verified) {
			if (inner === outer) continue;
			if (inner.start > outer.start && inner.start < outer.end) {
				return false;
			}
		}
	}

	const sortedVerified = [...verified].sort((a, b) => b.start - a.start);
	let remaining = command;
	for (const { start, end } of sortedVerified) {
		remaining = remaining.slice(0, start) + remaining.slice(end);
	}

	// The $() must be in argument position: heredoc-body-as-command-name plus
	// trailing args (e.g. $(cat <<'EOF'\nchmod\nEOF\n) 777 /etc/shadow) is unsafe
	const trimmedRemaining = remaining.trim();
	if (trimmedRemaining.length > 0) {
		const firstHeredocStart = Math.min(...verified.map((v) => v.start));
		const prefix = command.slice(0, firstHeredocStart);
		if (prefix.trim().length === 0) {
			return false;
		}
	}

	// Explicit ASCII space/tab only: \s would admit unicode whitespace and
	// newlines that hide content outside the heredoc body
	if (!/^[a-zA-Z0-9 \t"'.\-/_@=,:+~]*$/.test(remaining)) return false;

	// The stripped remainder must itself pass all validators (no recursion risk:
	// remaining contains no `$( ... <<` pattern)
	if (bashCommandIsSafe(remaining).behavior !== "passthrough") return false;

	return true;
}

function validateSafeCommandSubstitution(context: ValidationContext): BashSafetyResult {
	const { originalCommand } = context;

	if (!HEREDOC_IN_SUBSTITUTION.test(originalCommand)) {
		return { behavior: "passthrough", message: "No heredoc in substitution" };
	}

	if (isSafeHeredoc(originalCommand)) {
		return {
			behavior: "allow",
			message: "Safe command substitution: cat with quoted/escaped heredoc delimiter",
		};
	}

	return {
		behavior: "passthrough",
		message: "Command substitution needs validation",
	};
}

function validateGitCommit(context: ValidationContext): BashSafetyResult {
	const { originalCommand, baseCommand } = context;

	if (baseCommand !== "git" || !/^git\s+commit\s+/.test(originalCommand)) {
		return { behavior: "passthrough", message: "Not a git commit" };
	}

	// Backslashes mis-identify quote boundaries (e.g. "test\"msg" && evil);
	// legitimate commit messages virtually never contain them
	if (originalCommand.includes("\\")) {
		return {
			behavior: "passthrough",
			message: "Git commit contains backslash, needs full validation",
		};
	}

	// The class before -m excludes shell metacharacters and redirects so the
	// lazy prefix cannot swallow `; curl evil` style payloads; [ \t] keeps
	// whitespace horizontal-only (newlines are command separators)
	const messageMatch = originalCommand.match(/^git[ \t]+commit[ \t]+[^;&|`$<>()\n\r]*?-m[ \t]+(["'])([\s\S]*?)\1(.*)$/);

	if (messageMatch) {
		const [, quote, messageContent, remainder] = messageMatch;

		if (quote === '"' && messageContent && /\$\(|`|\$\{/.test(messageContent)) {
			return {
				behavior: "ask",
				message: "Git commit message contains command substitution patterns",
			};
		}

		// The prefix before -m can swallow flags like --amend, leaving
		// `&& evil` or `> ~/.bashrc` in the remainder
		if (remainder && /[;|&()`]|\$\(|\$\{/.test(remainder)) {
			return {
				behavior: "passthrough",
				message: "Git commit remainder contains shell metacharacters",
			};
		}
		if (remainder) {
			// Quoted <> (email brackets in --author) are safe; unquoted ones are
			// redirects that would bypass the early allow. No backslash handling
			// needed: the backslash check above already bailed on any backslash.
			let unquoted = "";
			let inSQ = false;
			let inDQ = false;
			for (let i = 0; i < remainder.length; i++) {
				const c = remainder[i];
				if (c === "'" && !inDQ) {
					inSQ = !inSQ;
					continue;
				}
				if (c === '"' && !inSQ) {
					inDQ = !inDQ;
					continue;
				}
				if (!inSQ && !inDQ) unquoted += c;
			}
			if (/[<>]/.test(unquoted)) {
				return {
					behavior: "passthrough",
					message: "Git commit remainder contains unquoted redirect operator",
				};
			}
		}

		// Block messages starting with dash (e.g. git commit -m "---")
		if (messageContent && messageContent.startsWith("-")) {
			return {
				behavior: "ask",
				message: "Command contains quoted characters in flag names",
			};
		}

		return {
			behavior: "allow",
			message: "Git commit with simple quoted message is allowed",
		};
	}

	return { behavior: "passthrough", message: "Git commit needs validation" };
}

// ============================================================================
// Main validators
// ============================================================================

function validateJqCommand(context: ValidationContext): BashSafetyResult {
	const { originalCommand, baseCommand } = context;

	if (baseCommand !== "jq") {
		return { behavior: "passthrough", message: "Not jq" };
	}

	if (/\bsystem\s*\(/.test(originalCommand)) {
		return {
			behavior: "ask",
			message: "jq command contains system() function which executes arbitrary commands",
		};
	}

	// Only flags that read files into jq variables are blocked; plain file
	// arguments go through path validation downstream
	const afterJq = originalCommand.substring(3).trim();
	if (/(?:^|\s)(?:-f\b|--from-file|--rawfile|--slurpfile|-L\b|--library-path)/.test(afterJq)) {
		return {
			behavior: "ask",
			message: "jq command contains dangerous flags that could execute code or read arbitrary files",
		};
	}

	return { behavior: "passthrough", message: "jq command is safe" };
}

function validateObfuscatedFlags(context: ValidationContext): BashSafetyResult {
	const { originalCommand, baseCommand } = context;

	// Echo is safe for obfuscated flags, BUT only for simple echo commands —
	// dangerous ANSI-C quoting may still follow a |, &, or ; operator
	const hasShellOperators = /[|&;]/.test(originalCommand);
	if (baseCommand === "echo" && !hasShellOperators) {
		return {
			behavior: "passthrough",
			message: "echo command is safe and has no dangerous flags",
		};
	}

	// 1. ANSI-C quoting ($'...') can encode any character via escape sequences
	if (/\$'[^']*'/.test(originalCommand)) {
		return {
			behavior: "ask",
			message: "Command contains ANSI-C quoting which can hide characters",
		};
	}

	// 2. Locale quoting ($"...")
	if (/\$"[^"]*"/.test(originalCommand)) {
		return {
			behavior: "ask",
			message: "Command contains locale quoting which can hide characters",
		};
	}

	// 3. Empty ANSI-C or locale quotes followed by dash: $''-exec, $""-exec
	if (/\$['"]{2}\s*-/.test(originalCommand)) {
		return {
			behavior: "ask",
			message: "Command contains empty special quotes before dash (potential bypass)",
		};
	}

	// 4. Any sequence of empty quote pairs followed by dash: ''- ""- ''""-
	if (/(?:^|\s)(?:''|"")+\s*-/.test(originalCommand)) {
		return {
			behavior: "ask",
			message: "Command contains empty quotes before dash (potential bypass)",
		};
	}

	// 4b. Homogeneous empty pair(s) adjacent to a quoted dash: """-f" is -f in
	// bash but slips past the checks above and the quote-state tracker
	if (/(?:""|'')+['"]-/.test(originalCommand)) {
		return {
			behavior: "ask",
			message: "Command contains empty quote pair adjacent to quoted dash (potential flag obfuscation)",
		};
	}

	// 4c. 3+ consecutive quotes at word start: """x"-f style shifts the dash
	// position; "x" always works, so legit commands never need this
	if (/(?:^|\s)['"]{3,}/.test(originalCommand)) {
		return {
			behavior: "ask",
			message: "Command contains consecutive quote characters at word start (potential obfuscation)",
		};
	}

	// Quote-state machine guarding the flag scanners below. Backslash is only
	// an escape outside single quotes ('\'; would desync the tracker otherwise).
	let inSingleQuote = false;
	let inDoubleQuote = false;
	let escaped = false;

	for (let i = 0; i < originalCommand.length - 1; i++) {
		const currentChar = originalCommand[i];
		const nextChar = originalCommand[i + 1];

		if (escaped) {
			escaped = false;
			continue;
		}

		if (currentChar === "\\" && !inSingleQuote) {
			escaped = true;
			continue;
		}

		if (currentChar === "'" && !inDoubleQuote) {
			inSingleQuote = !inSingleQuote;
			continue;
		}

		if (currentChar === '"' && !inSingleQuote) {
			inDoubleQuote = !inDoubleQuote;
			continue;
		}

		if (inSingleQuote || inDoubleQuote) {
			continue;
		}

		// Whitespace followed by a quote: flag obfuscation lives in the quote
		// content ("--flag", "-"exec, "-""exec", """-"exec)
		if (currentChar && nextChar && /\s/.test(currentChar) && /['"`]/.test(nextChar)) {
			const quoteChar = nextChar;
			let j = i + 2;
			let insideQuote = "";

			while (j < originalCommand.length && originalCommand[j] !== quoteChar) {
				insideQuote += originalCommand[j];
				j++;
			}

			const charAfterQuote = j + 1 < originalCommand.length ? originalCommand[j + 1] : undefined;
			// Inside DQ, $VAR and backticks expand at runtime, so "-$VAR" can
			// become -exec; glob chars are omitted on purpose (needs
			// attacker-controlled filenames, breaks `ls -- "-"*`)
			const FLAG_CONTINUATION_CHARS = /[a-zA-Z0-9\\${`-]/;
			const hasFlagCharsInside = /^-+[a-zA-Z0-9$`]/.test(insideQuote);
			const hasFlagCharsContinuing =
				/^-+$/.test(insideQuote) && charAfterQuote !== undefined && FLAG_CONTINUATION_CHARS.test(charAfterQuote);
			// Adjacent quote chaining: "-""exec" or """-"exec concatenate to a flag
			const hasFlagCharsInNextQuote =
				(insideQuote === "" || /^-+$/.test(insideQuote)) &&
				charAfterQuote !== undefined &&
				/['"`]/.test(charAfterQuote) &&
				(() => {
					let pos = j + 1;
					let combinedContent = insideQuote;
					while (pos < originalCommand.length && /['"`]/.test(originalCommand[pos])) {
						const segQuote = originalCommand[pos];
						let end = pos + 1;
						while (end < originalCommand.length && originalCommand[end] !== segQuote) {
							end++;
						}
						const segment = originalCommand.slice(pos + 1, end);
						combinedContent += segment;

						if (/^-+[a-zA-Z0-9$`]/.test(combinedContent)) return true;

						// Guard against segment.length === 0: slice(0, -0) → slice(0, 0) → ''
						const priorContent =
							segment.length > 0 ? combinedContent.slice(0, -segment.length) : combinedContent;
						if (/^-+$/.test(priorContent)) {
							if (/[a-zA-Z0-9$`]/.test(segment)) return true;
						}

						if (end >= originalCommand.length) break;
						pos = end + 1;
					}
					if (pos < originalCommand.length && FLAG_CONTINUATION_CHARS.test(originalCommand[pos])) {
						if (/^-+$/.test(combinedContent) || combinedContent === "") {
							const trailingChar = originalCommand[pos];
							if (trailingChar === "-") {
								return true;
							}
							if (/[a-zA-Z0-9\\${`]/.test(trailingChar) && combinedContent !== "") {
								return true;
							}
						}
						if (/^-/.test(combinedContent)) {
							return true;
						}
					}
					return false;
				})();
			if (
				j < originalCommand.length &&
				originalCommand[j] === quoteChar &&
				(hasFlagCharsInside || hasFlagCharsContinuing || hasFlagCharsInNextQuote)
			) {
				return {
					behavior: "ask",
					message: "Command contains quoted characters in flag names",
				};
			}
		}

		// Whitespace followed by dash: collect the flag, ending at whitespace/=,
		// or at a quote that clearly terminates it
		if (currentChar && nextChar && /\s/.test(currentChar) && nextChar === "-") {
			let j = i + 1;
			let flagContent = "";

			while (j < originalCommand.length) {
				const flagChar = originalCommand[j];
				if (!flagChar) break;

				if (/[\s=]/.test(flagChar)) {
					break;
				}
				if (/['"`]/.test(flagChar)) {
					// cut -d is the sole exception: its delimiter value may be quoted
					// (cut -d'"'); unrestricted, find -e"xec" would hide -exec
					if (baseCommand === "cut" && flagContent === "-d" && /['"`]/.test(flagChar)) {
						break;
					}

					if (j + 1 < originalCommand.length) {
						const nextFlagChar = originalCommand[j + 1];
						if (nextFlagChar && !/[a-zA-Z0-9_'"-]/.test(nextFlagChar)) {
							break;
						}
					}
				}
				flagContent += flagChar;
				j++;
			}

			if (flagContent.includes('"') || flagContent.includes("'")) {
				return {
					behavior: "ask",
					message: "Command contains quoted characters in flag names",
				};
			}
		}
	}

	// Flags starting with quotes: "--"output, '-'-output; fullyUnquotedContent
	// avoids false positives from legitimate quoted content like echo "---"
	if (/\s['"`]-/.test(context.fullyUnquotedContent)) {
		return {
			behavior: "ask",
			message: "Command contains quoted characters in flag names",
		};
	}

	// Cases like ""--output
	if (/['"`]{2}-/.test(context.fullyUnquotedContent)) {
		return {
			behavior: "ask",
			message: "Command contains quoted characters in flag names",
		};
	}

	return { behavior: "passthrough", message: "No obfuscated flags detected" };
}

function validateShellMetacharacters(context: ValidationContext): BashSafetyResult {
	const { unquotedContent } = context;
	const message = "Command contains shell metacharacters (;, |, or &) in arguments";

	if (/(?:^|\s)["'][^"']*[;&][^"']*["'](?:\s|$)/.test(unquotedContent)) {
		return { behavior: "ask", message };
	}

	const globPatterns = [
		/-name\s+["'][^"']*[;|&][^"']*["']/,
		/-path\s+["'][^"']*[;|&][^"']*["']/,
		/-iname\s+["'][^"']*[;|&][^"']*["']/,
	];

	if (globPatterns.some((p) => p.test(unquotedContent))) {
		return { behavior: "ask", message };
	}

	if (/-regex\s+["'][^"']*[;&][^"']*["']/.test(unquotedContent)) {
		return { behavior: "ask", message };
	}

	return { behavior: "passthrough", message: "No metacharacters" };
}

function validateDangerousVariables(context: ValidationContext): BashSafetyResult {
	const { fullyUnquotedContent } = context;

	if (
		/[<>|]\s*\$[A-Za-z_]/.test(fullyUnquotedContent) ||
		/\$[A-Za-z_][A-Za-z0-9_]*\s*[|<>]/.test(fullyUnquotedContent)
	) {
		return {
			behavior: "ask",
			message: "Command contains variables in dangerous contexts (redirections or pipes)",
		};
	}

	return { behavior: "passthrough", message: "No dangerous variables" };
}

function validateDangerousPatterns(context: ValidationContext): BashSafetyResult {
	const { unquotedContent } = context;

	// Escaped backticks (\`) are safe and common in SQL commands
	if (hasUnescapedChar(unquotedContent, "`")) {
		return {
			behavior: "ask",
			message: "Command contains backticks (`) for command substitution",
		};
	}

	for (const { pattern, message } of COMMAND_SUBSTITUTION_PATTERNS) {
		if (pattern.test(unquotedContent)) {
			return { behavior: "ask", message: `Command contains ${message}` };
		}
	}

	return { behavior: "passthrough", message: "No dangerous patterns" };
}

function validateRedirections(context: ValidationContext): BashSafetyResult {
	const { fullyUnquotedContent } = context;

	if (/</.test(fullyUnquotedContent)) {
		return {
			behavior: "ask",
			message: "Command contains input redirection (<) which could read sensitive files",
		};
	}

	if (/>/.test(fullyUnquotedContent)) {
		return {
			behavior: "ask",
			message: "Command contains output redirection (>) which could write to arbitrary files",
		};
	}

	return { behavior: "passthrough", message: "No redirections" };
}

function validateNewlines(context: ValidationContext): BashSafetyResult {
	// fullyUnquotedPreStrip prevents bypasses where stripping `>/dev/null`
	// creates a phantom backslash-newline continuation
	const { fullyUnquotedPreStrip } = context;

	if (!/[\n\r]/.test(fullyUnquotedPreStrip)) {
		return { behavior: "passthrough", message: "No newlines" };
	}

	// Flag newline/CR followed by non-whitespace, except word-boundary
	// backslash-newline continuations (mid-word ones can hide command names)
	const looksLikeCommand = /(?<![\s]\\)[\n\r]\s*\S/.test(fullyUnquotedPreStrip);
	if (looksLikeCommand) {
		return {
			behavior: "ask",
			message: "Command contains newlines that could separate multiple commands",
		};
	}

	return {
		behavior: "passthrough",
		message: "Newlines appear to be within data",
	};
}

/**
 * CR (0x0D) is a misparsing concern: shell-quote's `\s`-based tokenizer splits
 * on CR but bash's IFS does not, so `TZ=UTC\recho curl evil.com` hides the
 * real command from the parser. CR inside double quotes is the only safe case.
 */
function validateCarriageReturn(context: ValidationContext): BashSafetyResult {
	const { originalCommand } = context;

	if (!originalCommand.includes("\r")) {
		return { behavior: "passthrough", message: "No carriage return" };
	}

	let inSingleQuote = false;
	let inDoubleQuote = false;
	let escaped = false;
	for (let i = 0; i < originalCommand.length; i++) {
		const c = originalCommand[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (c === "\\" && !inSingleQuote) {
			escaped = true;
			continue;
		}
		if (c === "'" && !inDoubleQuote) {
			inSingleQuote = !inSingleQuote;
			continue;
		}
		if (c === '"' && !inSingleQuote) {
			inDoubleQuote = !inDoubleQuote;
			continue;
		}
		if (c === "\r" && !inDoubleQuote) {
			return {
				behavior: "ask",
				message: "Command contains carriage return (\\r) which shell-quote and bash tokenize differently",
			};
		}
	}

	return { behavior: "passthrough", message: "CR only inside double quotes" };
}

function validateIFSInjection(context: ValidationContext): BashSafetyResult {
	const { originalCommand } = context;

	// ${[^}]*IFS also catches parameter expansions like ${IFS:0:1}, ${#IFS}
	if (/\$IFS|\$\{[^}]*IFS/.test(originalCommand)) {
		return {
			behavior: "ask",
			message: "Command contains IFS variable usage which could bypass security validation",
		};
	}

	return { behavior: "passthrough", message: "No IFS injection detected" };
}

function validateProcEnvironAccess(context: ValidationContext): BashSafetyResult {
	const { originalCommand } = context;

	if (/\/proc\/.*\/environ/.test(originalCommand)) {
		return {
			behavior: "ask",
			message: "Command accesses /proc/*/environ which could expose sensitive environment variables",
		};
	}

	return {
		behavior: "passthrough",
		message: "No /proc/environ access detected",
	};
}

function validateMalformedTokenInjection(context: ValidationContext): BashSafetyResult {
	const { originalCommand } = context;

	const parseResult = tryParseShellCommand(originalCommand);
	if (!parseResult.success) {
		// Parse failure is handled by the caller's parse gate, not here
		return {
			behavior: "passthrough",
			message: "Parse failed, handled elsewhere",
		};
	}

	const parsed = parseResult.tokens;

	const hasCommandSeparator = parsed.some(
		(entry) =>
			typeof entry === "object" &&
			entry !== null &&
			"op" in entry &&
			(entry.op === ";" || entry.op === "&&" || entry.op === "||"),
	);

	if (!hasCommandSeparator) {
		return { behavior: "passthrough", message: "No command separators" };
	}

	if (hasMalformedTokens(originalCommand, parsed)) {
		return {
			behavior: "ask",
			message: "Command contains ambiguous syntax with command separators that could be misinterpreted",
		};
	}

	return {
		behavior: "passthrough",
		message: "No malformed token injection detected",
	};
}

/**
 * `echo\ test` is ONE bash token but two tokens after escape decoding, enabling
 * path-traversal attacks like `echo\ test/../../../usr/bin/touch /tmp/file`.
 */
function hasBackslashEscapedWhitespace(command: string): boolean {
	let inSingleQuote = false;
	let inDoubleQuote = false;

	for (let i = 0; i < command.length; i++) {
		const char = command[i];

		if (char === "\\" && !inSingleQuote) {
			if (!inDoubleQuote) {
				const nextChar = command[i + 1];
				if (nextChar === " " || nextChar === "\t") {
					return true;
				}
			}
			// Skip the escaped character (also valid inside double quotes)
			i++;
			continue;
		}

		if (char === '"' && !inSingleQuote) {
			inDoubleQuote = !inDoubleQuote;
			continue;
		}

		if (char === "'" && !inDoubleQuote) {
			inSingleQuote = !inSingleQuote;
		}
	}

	return false;
}

function validateBackslashEscapedWhitespace(context: ValidationContext): BashSafetyResult {
	if (hasBackslashEscapedWhitespace(context.originalCommand)) {
		return {
			behavior: "ask",
			message: "Command contains backslash-escaped whitespace that could alter command parsing",
		};
	}

	return {
		behavior: "passthrough",
		message: "No backslash-escaped whitespace",
	};
}

/**
 * Flags any \<operator> regardless of backslash parity: splitCommand normalizes
 * `\;` to a bare `;`, and re-parsing that output false-splits the command
 * (`cat safe.txt \; echo ~/.ssh/id_rsa` hides the sensitive file). Even counts
 * (\\;) are dangerous in bash too (\\ → \, ; separates).
 */
function hasBackslashEscapedOperator(command: string): boolean {
	let inSingleQuote = false;
	let inDoubleQuote = false;

	for (let i = 0; i < command.length; i++) {
		const char = command[i];

		// Backslash before quote toggles: inside DQ, \" escapes the quote rather
		// than closing it; unconditional i++ keeps `"x\\"` parity correct
		if (char === "\\" && !inSingleQuote) {
			if (!inDoubleQuote) {
				const nextChar = command[i + 1];
				if (nextChar && SHELL_OPERATORS.has(nextChar)) {
					return true;
				}
			}
			i++;
			continue;
		}

		if (char === "'" && !inDoubleQuote) {
			inSingleQuote = !inSingleQuote;
			continue;
		}
		if (char === '"' && !inSingleQuote) {
			inDoubleQuote = !inDoubleQuote;
		}
	}

	return false;
}

function validateBackslashEscapedOperators(context: ValidationContext): BashSafetyResult {
	if (hasBackslashEscapedOperator(context.originalCommand)) {
		return {
			behavior: "ask",
			message: "Command contains a backslash before a shell operator (;, |, &, <, >) which can hide command structure",
		};
	}

	return {
		behavior: "passthrough",
		message: "No backslash-escaped operators",
	};
}

/** Odd number of consecutive backslashes before pos means pos is escaped. */
function isEscapedAtPosition(content: string, pos: number): boolean {
	let backslashCount = 0;
	let i = pos - 1;
	while (i >= 0 && content[i] === "\\") {
		backslashCount++;
		i--;
	}
	return backslashCount % 2 === 1;
}

/**
 * Unquoted brace expansion ({a,b}, {1..5}) is invisible to the parser, letting
 * `git ls-remote {--upload-pack="touch /tmp/test",test}` smuggle flags. Quotes
 * and backslashes suppress expansion, hence fullyUnquotedPreStrip.
 */
function validateBraceExpansion(context: ValidationContext): BashSafetyResult {
	const content = context.fullyUnquotedPreStrip;

	// Excess unescaped `}` after quote stripping (e.g. git diff {@'{'0},--output=…)
	// means the depth matcher below would close at the wrong brace
	let unescapedOpenBraces = 0;
	let unescapedCloseBraces = 0;
	for (let i = 0; i < content.length; i++) {
		if (content[i] === "{" && !isEscapedAtPosition(content, i)) {
			unescapedOpenBraces++;
		} else if (content[i] === "}" && !isEscapedAtPosition(content, i)) {
			unescapedCloseBraces++;
		}
	}
	if (unescapedOpenBraces > 0 && unescapedCloseBraces > unescapedOpenBraces) {
		return {
			behavior: "ask",
			message: "Command has excess closing braces after quote stripping, indicating possible brace expansion obfuscation",
		};
	}

	// A quoted single brace inside an unquoted brace context is the attack
	// primitive itself (legit commands like awk '{print $1}' quote the outer
	// brace too)
	if (unescapedOpenBraces > 0) {
		const orig = context.originalCommand;
		if (/['"][{}]['"]/.test(orig)) {
			return {
				behavior: "ask",
				message: "Command contains quoted brace character inside brace context (potential brace expansion obfuscation)",
			};
		}
	}

	// Manual scan instead of a lookbehind regex: lookbehinds can't handle
	// double-escaped backslashes (\\{ is an unescaped `{`)
	for (let i = 0; i < content.length; i++) {
		if (content[i] !== "{") continue;
		if (isEscapedAtPosition(content, i)) continue;

		let depth = 1;
		let matchingClose = -1;
		for (let j = i + 1; j < content.length; j++) {
			const ch = content[j];
			if (ch === "{" && !isEscapedAtPosition(content, j)) {
				depth++;
			} else if (ch === "}" && !isEscapedAtPosition(content, j)) {
				depth--;
				if (depth === 0) {
					matchingClose = j;
					break;
				}
			}
		}

		if (matchingClose === -1) continue;

		// Only outermost-level , or .. triggers matter — bash splits expansion there
		let innerDepth = 0;
		for (let k = i + 1; k < matchingClose; k++) {
			const ch = content[k];
			if (ch === "{" && !isEscapedAtPosition(content, k)) {
				innerDepth++;
			} else if (ch === "}" && !isEscapedAtPosition(content, k)) {
				innerDepth--;
			} else if (innerDepth === 0) {
				if (ch === "," || (ch === "." && k + 1 < matchingClose && content[k + 1] === ".")) {
					return {
						behavior: "ask",
						message: "Command contains brace expansion that could alter command parsing",
					};
				}
			}
		}
	}

	return {
		behavior: "passthrough",
		message: "No brace expansion detected",
	};
}

function validateUnicodeWhitespace(context: ValidationContext): BashSafetyResult {
	const { originalCommand } = context;
	if (UNICODE_WS_RE.test(originalCommand)) {
		return {
			behavior: "ask",
			message: "Command contains Unicode whitespace characters that could cause parsing inconsistencies",
		};
	}
	return { behavior: "passthrough", message: "No Unicode whitespace" };
}

function validateMidWordHash(context: ValidationContext): BashSafetyResult {
	const { unquotedKeepQuoteChars } = context;
	// shell-quote treats mid-word # as comment start, bash as literal. Checked
	// on both the raw and continuation-joined views (foo\<NL>#bar differs).
	const joined = unquotedKeepQuoteChars.replace(/\\+\n/g, (match) => {
		const backslashCount = match.length - 1;
		return backslashCount % 2 === 1 ? "\\".repeat(backslashCount - 1) : match;
	});
	if (/\S(?<!\$\{)#/.test(unquotedKeepQuoteChars) || /\S(?<!\$\{)#/.test(joined)) {
		return {
			behavior: "ask",
			message: "Command contains mid-word # which is parsed differently by shell-quote vs bash",
		};
	}
	return { behavior: "passthrough", message: "No mid-word hash" };
}

/**
 * Quote chars after an unquoted # desync downstream quote trackers (comments
 * are literal in bash but toggle our state), hiding following lines from
 * newline/quote-sensitive validators.
 */
function validateCommentQuoteDesync(context: ValidationContext): BashSafetyResult {
	const { originalCommand } = context;

	let inSingleQuote = false;
	let inDoubleQuote = false;
	let escaped = false;

	for (let i = 0; i < originalCommand.length; i++) {
		const char = originalCommand[i];

		if (escaped) {
			escaped = false;
			continue;
		}

		if (inSingleQuote) {
			if (char === "'") inSingleQuote = false;
			continue;
		}

		if (char === "\\") {
			escaped = true;
			continue;
		}

		if (inDoubleQuote) {
			if (char === '"') inDoubleQuote = false;
			continue;
		}

		if (char === "'") {
			inSingleQuote = true;
			continue;
		}

		if (char === '"') {
			inDoubleQuote = true;
			continue;
		}

		if (char === "#") {
			const lineEnd = originalCommand.indexOf("\n", i);
			const commentText = originalCommand.slice(i + 1, lineEnd === -1 ? originalCommand.length : lineEnd);
			if (/['"]/.test(commentText)) {
				return {
					behavior: "ask",
					message: "Command contains quote characters inside a # comment which can desync quote tracking",
				};
			}
			if (lineEnd === -1) break;
			i = lineEnd;
		}
	}

	return { behavior: "passthrough", message: "No comment quote desync" };
}

/**
 * A newline inside quotes where the next line trims to a leading # is the
 * exact trigger for line-based comment stripping, which can drop sensitive
 * arguments (e.g. mv ./decoy '<\n>#' ~/.ssh/id_rsa ./exfil_dir).
 */
function validateQuotedNewline(context: ValidationContext): BashSafetyResult {
	const { originalCommand } = context;

	if (!originalCommand.includes("\n") || !originalCommand.includes("#")) {
		return { behavior: "passthrough", message: "No newline or no hash" };
	}

	let inSingleQuote = false;
	let inDoubleQuote = false;
	let escaped = false;

	for (let i = 0; i < originalCommand.length; i++) {
		const char = originalCommand[i];

		if (escaped) {
			escaped = false;
			continue;
		}

		if (char === "\\" && !inSingleQuote) {
			escaped = true;
			continue;
		}

		if (char === "'" && !inDoubleQuote) {
			inSingleQuote = !inSingleQuote;
			continue;
		}

		if (char === '"' && !inSingleQuote) {
			inDoubleQuote = !inDoubleQuote;
			continue;
		}

		if (char === "\n" && (inSingleQuote || inDoubleQuote)) {
			const lineStart = i + 1;
			const nextNewline = originalCommand.indexOf("\n", lineStart);
			const lineEnd = nextNewline === -1 ? originalCommand.length : nextNewline;
			const nextLine = originalCommand.slice(lineStart, lineEnd);
			if (nextLine.trim().startsWith("#")) {
				return {
					behavior: "ask",
					message:
						"Command contains a quoted newline followed by a #-prefixed line, which can hide arguments from line-based permission checks",
				};
			}
		}
	}

	return { behavior: "passthrough", message: "No quoted newline-hash pattern" };
}

function validateZshDangerousCommands(context: ValidationContext): BashSafetyResult {
	const { originalCommand } = context;

	const ZSH_PRECOMMAND_MODIFIERS = new Set(["command", "builtin", "noglob", "nocorrect"]);
	const trimmed = originalCommand.trim();
	const tokens = trimmed.split(/\s+/);
	let baseCmd = "";
	for (const token of tokens) {
		if (/^[A-Za-z_]\w*=/.test(token)) continue;
		if (ZSH_PRECOMMAND_MODIFIERS.has(token)) continue;
		baseCmd = token;
		break;
	}

	if (ZSH_DANGEROUS_COMMANDS.has(baseCmd)) {
		return {
			behavior: "ask",
			message: `Command uses Zsh-specific '${baseCmd}' which can bypass security checks`,
		};
	}

	// fc -e runs an arbitrary editor command on history — an eval equivalent;
	// fc without -e only lists history
	if (baseCmd === "fc" && /\s-\S*e/.test(trimmed)) {
		return {
			behavior: "ask",
			message: "Command uses 'fc -e' which can execute arbitrary commands via editor",
		};
	}

	return {
		behavior: "passthrough",
		message: "No Zsh dangerous commands",
	};
}

function validateNetworkDeviceRedirect(context: ValidationContext): BashSafetyResult {
	// fullyUnquotedContent also catches quoted variants like "/dev/tcp/..."
	if (NETWORK_DEVICE_PATH_RE.test(context.fullyUnquotedContent)) {
		return {
			behavior: "ask",
			message: "Command uses /dev/tcp or /dev/udp network pseudo-device which can be used for network access",
		};
	}

	return {
		behavior: "passthrough",
		message: "No network device redirects",
	};
}

// ============================================================================
// Entry point
// ============================================================================

/**
 * Synchronous regex-based bash injection heuristic check (CC
 * `bashCommandIsSafe_DEPRECATED`). "allow" never escapes this module: early
 * allows are surfaced as `passthrough`, asks are surfaced as `ask` — with
 * `isBashSecurityCheckForMisparsing` except for `validateNewlines` and
 * `validateRedirections`, whose asks are deferred until all misparsing
 * validators have had their chance.
 */
export function bashCommandIsSafe(command: string): BashSafetyResult {
	// Control chars are silently dropped by bash but confuse every quote
	// tracker here — must run before any other processing
	if (CONTROL_CHAR_RE.test(command)) {
		return {
			behavior: "ask",
			message: "Command contains non-printable control characters that could be used to bypass security checks",
			isBashSecurityCheckForMisparsing: true,
		};
	}

	if (hasShellQuoteSingleQuoteBug(command)) {
		return {
			behavior: "ask",
			message: "Command contains single-quoted backslash pattern that could bypass security checks",
			isBashSecurityCheckForMisparsing: true,
		};
	}

	const { processedCommand } = extractHeredocs(command, { quotedOnly: true });

	const baseCommand = command.split(" ")[0] || "";
	const { withDoubleQuotes, fullyUnquoted, unquotedKeepQuoteChars } = extractQuotedContent(
		processedCommand,
		baseCommand === "jq",
	);

	const context: ValidationContext = {
		originalCommand: command,
		baseCommand,
		unquotedContent: withDoubleQuotes,
		fullyUnquotedContent: stripSafeRedirections(fullyUnquoted),
		fullyUnquotedPreStrip: fullyUnquoted,
		unquotedKeepQuoteChars,
	};

	const earlyValidators: Validator[] = [
		validateEmpty,
		validateIncompleteCommands,
		validateSafeCommandSubstitution,
		validateGitCommit,
	];

	for (const validator of earlyValidators) {
		const result = validator(context);
		if (result.behavior === "allow") {
			return {
				behavior: "passthrough",
				message: result.message ?? "Command allowed",
			};
		}
		if (result.behavior !== "passthrough") {
			return result.behavior === "ask" ? { ...result, isBashSecurityCheckForMisparsing: true } : result;
		}
	}

	// LF newlines and redirections are normal patterns that splitCommand handles
	// correctly — not misparsing concerns. validateCarriageReturn is NOT here:
	// CR is a tokenization differential.
	const nonMisparsingValidators = new Set<Validator>([validateNewlines, validateRedirections]);

	const validators: Validator[] = [
		validateJqCommand,
		validateObfuscatedFlags,
		validateShellMetacharacters,
		validateDangerousVariables,
		// Comment-quote-desync and quoted-newline run before validateNewlines:
		// they detect the cases where the quote tracker would miss newlines
		validateCommentQuoteDesync,
		validateQuotedNewline,
		// CR is a misparsing concern, LF is not
		validateCarriageReturn,
		validateNewlines,
		validateIFSInjection,
		validateProcEnvironAccess,
		validateDangerousPatterns,
		validateRedirections,
		validateBackslashEscapedWhitespace,
		validateBackslashEscapedOperators,
		validateUnicodeWhitespace,
		validateMidWordHash,
		validateBraceExpansion,
		validateZshDangerousCommands,
		validateNetworkDeviceRedirect,
		// Malformed tokens last — earlier validators have more precise messages
		validateMalformedTokenInjection,
	];

	// Non-misparsing asks must NOT short-circuit: a later misparsing validator
	// (e.g. backslash-escaped operators) takes priority, otherwise a payload
	// like `cat safe.txt \; echo /etc/passwd > ./out` could slip through
	let deferredNonMisparsingResult: BashSafetyResult | null = null;
	for (const validator of validators) {
		const result = validator(context);
		if (result.behavior === "ask") {
			if (nonMisparsingValidators.has(validator)) {
				if (deferredNonMisparsingResult === null) {
					deferredNonMisparsingResult = result;
				}
				continue;
			}
			return { ...result, isBashSecurityCheckForMisparsing: true };
		}
	}
	if (deferredNonMisparsingResult !== null) {
		return deferredNonMisparsingResult;
	}

	return {
		behavior: "passthrough",
		message: "Command passed all security checks",
	};
}
