/**
 * Bash tool permission check, porting the legacy (non-AST) core of Claude
 * Code's `bashToolHasPermission`: split the command into subcommands, match
 * deny/ask/allow content rules per segment (deny anywhere wins), keep the
 * injection/security heuristics and path constraints in front of any allow,
 * auto-approve fully read-only commands, and emit "always allow" suggestions.
 *
 * Path constraints cover redirect targets, removal arguments, and — via the
 * CC path-validation engine (`./bash-path-validation`) — the path arguments
 * of ~35 filesystem commands (cat, ls, find, mkdir, touch, mv, cp, sed, …).
 *
 * Adaptations: segmentation uses the host tokenizer (`tools/shell-tokenize`);
 * CC's two-stage async gates, sandbox and classifier hooks are omitted. The
 * structure-proof half of CC's AST analysis is ported (`./bash-ast`): when the
 * vendored tree-sitter bash parser is loaded, AST-extracted redirect targets
 * are validated additively on top of the tokenizer scan.
 */

import { t } from "@oh-my-pi/pi-i18n";
import { stripSafeWrappers } from "./core/safeCommandStrip";
import { ensureBashAstLoaded, isBashAstWriteRedirect, parseBashAstSync } from "./bash-ast";
import { getDestructiveCommandWarning } from "./destructive-command-warning";
import { modeAllowForSegment } from "./mode-validation";
import { checkSedConstraints } from "./sed-validation";
import { isReadOnlySegment } from "./bash-read-only";
import { cfgPermissionsBashReadOnlyAutoAllow } from "./settings";
import { settings } from "../config/settings";
import { tokenizeShellSegments } from "../tools/shell-tokenize";
import { bashCommandIsSafe } from "./bash-security";
import { checkProcessSubstitution, validateSegmentCommandPaths } from "./bash-path-validation";
import { isDangerousRemovalPath } from "./core/pathSafety";
import { validatePath } from "./core/pathValidation";
import {
	matchWildcardPattern,
	parsePermissionRule,
	suggestionForExactCommand,
	suggestionForPrefix,
} from "./core/shellRuleMatching";
import type {
	ParsedRules,
	PermissionCheckContext,
	PermissionDecisionReason,
	PermissionResult,
	PermissionRule,
} from "./core/types";

const MAX_SUBCOMMANDS_FOR_SECURITY_CHECK = 50;
const BARE_SHELL_PREFIXES = new Set([
	"sh",
	"bash",
	"zsh",
	"fish",
	"csh",
	"tcsh",
	"ksh",
	"dash",
	"cmd",
	"powershell",
	"pwsh",
	"env",
	"xargs",
	"nice",
	"stdbuf",
	"nohup",
	"timeout",
	"time",
	"sudo",
	"doas",
	"pkexec",
]);
const REMOVAL_COMMANDS = new Set(["rm", "rmdir", "unlink"]);

type PathOptions = { rules: ParsedRules; workingDirectories: string[]; mode: PermissionCheckContext["mode"] };

function ruleContentMatches(rule: PermissionRule, candidate: string, compound: boolean): boolean {
	const content = rule.ruleValue.ruleContent;
	if (content === undefined) return false;
	const parsed = parsePermissionRule(content);
	switch (parsed.type) {
		case "exact":
			return candidate === parsed.command;
		case "prefix":
			// Prefix/wildcard rules never match a compound candidate — each
			// subcommand must match on its own (prevents `git status && rm -rf /`
			// riding a `git:*` allow).
			if (compound) return false;
			return candidate === parsed.prefix || candidate.startsWith(`${parsed.prefix} `);
		case "wildcard":
			if (compound) return false;
			return matchWildcardPattern(parsed.pattern, candidate);
	}
}

function findMatchingRule(
	rules: readonly PermissionRule[],
	candidate: string,
	compound: boolean,
): PermissionRule | null {
	for (const rule of rules) {
		if (rule.ruleValue.toolName !== "bash") continue;
		if (ruleContentMatches(rule, candidate, compound)) return rule;
	}
	return null;
}

function splitSegments(command: string): string[][] {
	const segments = tokenizeShellSegments(command);
	return segments.length > 0 ? segments : [[]];
}

const joinSegment = (tokens: string[]): string => tokens.join(" ");

export function bashToolCheckPermission(
	toolName: string,
	input: Record<string, unknown>,
	ctx: PermissionCheckContext,
): PermissionResult {
	const result = bashToolCheckPermissionInner(toolName, input, ctx);
	// CC parity: destructive-command notes ride on every bash ask (purely
	// informational — they never change the decision itself).
	if (result.behavior === "ask" && typeof input.command === "string") {
		const warning = getDestructiveCommandWarning(input.command);
		if (warning) return { ...result, message: `${result.message} ${warning}` };
	}
	return result;
}

function bashToolCheckPermissionInner(
	_toolName: string,
	input: Record<string, unknown>,
	ctx: PermissionCheckContext,
): PermissionResult {
	const command = input.command;
	if (typeof command !== "string" || command.trim().length === 0) {
		return { behavior: "passthrough", message: t("Permission requested to use bash.") };
	}
	const options: PathOptions = {
		rules: ctx.rules,
		workingDirectories: [process.cwd(), ...ctx.workingDirectories.keys()],
		mode: ctx.mode,
	};
	const segmentTokens = splitSegments(command);
	const segments = segmentTokens.map(joinSegment).filter(seg => seg.length > 0);
	const compound = segments.length > 1 || /[;&|]|\n/.test(command);

	// 1. Whole-command deny / ask rules. CC matches rules against the
	// wrapper/env-var-stripped command (stripSafeWrappers), so `NO_COLOR=1
	// denied_cmd` cannot evade a deny and `NO_COLOR=1 allowed_cmd` can ride an
	// allow; the raw command is tried first and stays authoritative.
	const strippedWhole = stripSafeWrappers(command);
	const wholeDenyCandidate = strippedWhole && strippedWhole !== command ? strippedWhole : null;
	const denyRule =
		findMatchingRule(ctx.rules.deny, command, compound) ??
		(wholeDenyCandidate ? findMatchingRule(ctx.rules.deny, wholeDenyCandidate, compound) : null);
	if (denyRule) {
		return {
			behavior: "deny",
			message: t("Permission to run this command has been denied."),
			decisionReason: { type: "rule", rule: denyRule },
		};
	}
	const askRule =
		findMatchingRule(ctx.rules.ask, command, compound) ??
		(wholeDenyCandidate ? findMatchingRule(ctx.rules.ask, wholeDenyCandidate, compound) : null);
	if (askRule) {
		return {
			behavior: "ask",
			message: t(`Permission to run this command requires confirmation by rule.`),
			decisionReason: { type: "rule", rule: askRule },
		};
	}

	// 2. Subcommand deny — a deny rule anywhere in the chain wins. Segments are
	// additionally tried wrapper-stripped for the same under-block reason as
	// step 1.
	const subcommandResults = new Map<string, PermissionResult>();
	for (const segment of segments) {
		const strippedSegment = stripSafeWrappers(segment);
		const segmentDeny =
			findMatchingRule(ctx.rules.deny, segment, false) ??
			(strippedSegment && strippedSegment !== segment
				? findMatchingRule(ctx.rules.deny, strippedSegment, false)
				: null);
		if (segmentDeny) {
			subcommandResults.set(segment, {
				behavior: "deny",
				message: t(`Denied by rule.`),
				decisionReason: { type: "rule", rule: segmentDeny },
			});
			return {
				behavior: "deny",
				message: t("Permission to run this command has been denied (subcommand: {{segment}}).", { segment }),
				decisionReason: { type: "subcommandResults", reasons: subcommandResults },
			};
		}
	}

	// 3. Security heuristics on the full command. Only misparsing asks promote
	// to a prompt (CC semantics): the misparse gate exists because approving a
	// misparsed wrapper would approve an unseen body — moot under
	// bypassPermissions, where nothing is being individually approved and CC's
	// bypass short-circuit precedes the safety check. Deferred non-misparsing
	// asks (redirections, newlines, …) are dropped here — their surface is
	// covered by the path-constraint step below and by rule/mode flow, matching
	// CC's early-block-only consumer.
	const safety = bashCommandIsSafe(command);
	if (
		safety.behavior === "ask" &&
		safety.isBashSecurityCheckForMisparsing &&
		options.mode !== "bypassPermissions"
	) {
		return {
			behavior: "ask",
			message: t("Permission to run this command requires confirmation: {{reason}}", {
				reason: safety.message ?? t("security check flagged this command"),
			}),
			decisionReason: {
				type: "safetyCheck",
				reason: safety.message ?? "bash security check",
				classifierApprovable: true,
			},
		};
	}

	// 4. Multiple cd / cd+git compounds need human review (CC parity).
	const cdCount = segments.filter(seg => /^(cd|pushd|popd)(\s|$)/.test(seg)).length;
	if (cdCount > 1) {
		return {
			behavior: "ask",
			message: t("Multiple directory changes in one command require approval for clarity."),
			decisionReason: { type: "other", reason: "multiple cd segments" },
		};
	}
	const hasGit = segments.some(seg => /(^|\s)xargs\s+git(\s|$)|(^|\s)git(\s|$)/.test(seg));
	if (cdCount > 0 && hasGit) {
		return {
			behavior: "ask",
			message: t("Combining directory changes with git commands requires approval (bare-repository protection)."),
			decisionReason: { type: "other", reason: "cd + git compound" },
		};
	}

	// 5. Path constraints: redirect targets, removal arguments, and every
	// path-command's file arguments are file operations in disguise. The cd
	// detection from step 4 doubles as CC's compoundCommandHasCd for the
	// cd+write / cd+redirect gates. The result is merged at step 6.4 (GH#28784
	// ordering) rather than short-circuiting here.
	const pathResult = checkPathConstraints(command, segmentTokens, options, cdCount > 0);

	// 5b. Sed constraints (CC checkSedConstraints, runs before mode auto-allow):
	// blocks in-place edits, s///e execution, and file-writing sed commands.
	for (let i = 0; i < segmentTokens.length; i++) {
		const sedResult = checkSedConstraints(segmentTokens[i], segments[i] ?? "");
		if (sedResult.behavior === "ask") {
			const reason = sedResult.message ?? "dangerous sed operation";
			return {
				behavior: "ask",
				message: t("Permission to run this command requires confirmation: {{reason}}", { reason }),
				decisionReason: { type: "safetyCheck", reason, classifierApprovable: true },
			};
		}
	}

	// 6. Per-segment allow / ask rule collection (wrapper-stripped fallback, as
	// in steps 1-2).
	// CC-643: cap subcommand fanout — beyond the cap the per-segment safety
	// checks cannot be trusted to cover everything, so ask.
	if (segments.length > MAX_SUBCOMMANDS_FOR_SECURITY_CHECK) {
		const reason = `Command splits into ${segments.length} subcommands, too many to safety-check individually`;
		return {
			behavior: "ask",
			message: t("Permission to run this command requires confirmation: {{reason}}", { reason }),
			decisionReason: { type: "other", reason },
		};
	}
	const reasonMap = new Map<string, PermissionResult>();
	let firstAsk: { segment: string; rule: PermissionRule } | undefined;
	let askCount = 0;
	let allAllowed = segments.length > 0;
	for (const segment of segments) {
		const strippedSegment = stripSafeWrappers(segment);
		const allowMatch =
			findMatchingRule(ctx.rules.allow, segment, false) ??
			(strippedSegment && strippedSegment !== segment
				? findMatchingRule(ctx.rules.allow, strippedSegment, false)
				: null);
		if (allowMatch) {
			reasonMap.set(segment, { behavior: "allow", decisionReason: { type: "rule", rule: allowMatch } });
			continue;
		}
		allAllowed = false;
		const askMatch =
			findMatchingRule(ctx.rules.ask, segment, false) ??
			(strippedSegment && strippedSegment !== segment
				? findMatchingRule(ctx.rules.ask, strippedSegment, false)
				: null);
		if (askMatch) {
			askCount += 1;
			if (!firstAsk) firstAsk = { segment, rule: askMatch };
		}
	}
	// 6.4. GH#28784 merge ordering (CC parity): a path-constraint deny wins;
	// a path-constraint ask only short-circuits when no subcommand
	// independently produced an ask (otherwise the prompt's suggestion could
	// silently approve a non-allow subcommand riding the compound); and an
	// all-allow subcommand set does NOT swallow a pending path ask.
	if (pathResult?.behavior === "deny") return pathResult;
	if (pathResult?.behavior === "ask" && !firstAsk) return pathResult;
	if (allAllowed) {
		return {
			behavior: "allow",
			decisionReason: { type: "subcommandResults", reasons: reasonMap },
		};
	}
	if (firstAsk && askCount === 1) {
		return {
			behavior: "ask",
			message: t("Permission to run this command requires confirmation (subcommand: {{segment}}).", {
				segment: firstAsk.segment,
			}),
			decisionReason: { type: "rule", rule: firstAsk.rule },
		};
	}

	// 6.5. Mode-specific auto-allow (CC modeValidation step 6): acceptEdits
	// approves the plain filesystem commands once the merge above settled —
	// out-of-cwd path asks and ask-rules still win.
	if (ctx.mode === "acceptEdits") {
		for (const segment of segments) {
			const modeAllow = modeAllowForSegment(segment, ctx.mode);
			if (modeAllow) {
				return { behavior: "allow", decisionReason: modeAllow.decisionReason };
			}
		}
	}

	// 7. Read-only auto-approval, ported from CC step 7 but gated behind
	// permissions.bashReadOnlyAutoAllow (default off): omp's default posture
	// treats bash as exec-tier and prompts for it in ask-preserving modes.
	// When opted in, verified read-only commands allow outright. The flag read
	// is guarded: this predicate runs in contexts (unit tests, early init)
	// where the settings singleton may not be initialized — treat that as off.
	let bashReadOnlyEnabled = false;
	try {
		bashReadOnlyEnabled = cfgPermissionsBashReadOnlyAutoAllow.get(settings);
	} catch {
		// settings not initialized — feature stays off
	}
	if (bashReadOnlyEnabled) {
		let allReadOnly = segmentTokens.length > 0;
		for (let i = 0; i < segmentTokens.length; i++) {
			if (!isReadOnlySegment(segmentTokens[i], segments[i] ?? "")) {
				allReadOnly = false;
				break;
			}
		}
		if (allReadOnly) {
			return { behavior: "allow", decisionReason: { type: "other", reason: "Read-only command is allowed" } };
		}
	}

	// 8. Nothing said allow: defer to the mode flow with an always-allow
	// suggestion (prefix when it names a meaningful subcommand).
	return {
		behavior: "passthrough",
		message: t("Permission requested to run this command."),
		suggestions: suggestBashRules(segments[0] ?? command),
	};
}

/**
 * SECURITY: tokens the tokenizer emits as standalone output-redirect operators
 * (`>`, `>>`, `>&`, `>|`, fd-prefixed `2>`/`2>&`, read-write `<>`). The
 * tokenizer keeps them out of adjacent words so glued forms like
 * `echo hi>/etc/passwd` or `echo 'a\'>file` still surface here.
 */
const REDIRECT_WRITE_OP_RE = /^\d*>+[&|]?$|^\d*<>$/u;

/**
 * True when `tokens[i]` is an output-redirect operator and `tokens[i + 1]` is a
 * real file target: not an fd dup (`2>&1` — only `&`-bearing operators dup to
 * a digit; plain `2>3` writes a file named `3`). `devNullCounts` keeps CC's
 * cd-gate parity, where any output redirection in a cd compound asks even when
 * the target is `/dev/null` (only the per-target validation skips it).
 */
function isFileRedirectTarget(tokens: string[], i: number, devNullCounts = false): boolean {
	if (!REDIRECT_WRITE_OP_RE.test(tokens[i])) return false;
	const target = tokens[i + 1];
	if (!target || target.startsWith("&")) return false;
	// `&`-bearing operators (`>&`, `2>&`) duplicate to a descriptor when the
	// target is a bare number; without `&` the number is a filename.
	if (tokens[i].includes("&") && /^\d+$/.test(target)) return false;
	if (!devNullCounts && target === "/dev/null") return false;
	return true;
}

function checkPathConstraints(
	command: string,
	segmentTokens: string[][],
	options: PathOptions,
	compoundHasCd: boolean,
): PermissionResult | undefined {
	// SECURITY: Process substitution >(cmd)/<(cmd) can execute commands that
	// write to files without those files appearing as redirect targets — e.g.
	// `echo secret > >(tee .git/config)`. bash-security's quote-aware scan
	// catches unquoted forms earlier; this raw-text gate is the CC-ported
	// backstop. Suppressed under bypassPermissions like other non-immune asks.
	const processSubstitution = checkProcessSubstitution(command);
	if (processSubstitution && options.mode !== "bypassPermissions") return processSubstitution;

	// SECURITY (CC): output redirections in compound commands containing 'cd'
	// resolve their target against the original cwd while the write lands in
	// the changed directory after `cd` executes. Ask before validating targets.
	// Like the cd+write gate, this is a CC type-'other' ask: skipped under
	// bypassPermissions (only bypass-immune safetyChecks survive bypass there).
	if (compoundHasCd && options.mode !== "bypassPermissions" && segmentTokens.some(hasFileRedirectTarget)) {
		return {
			behavior: "ask",
			message: t(
				"Commands that change directories and write via output redirection require explicit approval to ensure paths are evaluated correctly: the final working directory cannot be determined when 'cd' is used in compound commands.",
			),
			decisionReason: {
				type: "other",
				reason:
					"Compound command contains cd with output redirection - manual approval required to prevent path resolution bypass",
			},
		};
	}

	// SECURITY (CC tree-sitter parity): redirect targets extracted from the real
	// bash grammar are structure-proof against tokenizer blind spots (glued
	// operators, quote desyncs, hidden substitution bodies) and validate through
	// the same validatePath flow. Additive with the token scan below: the loader
	// warms asynchronously, so early calls see null and fall back to the
	// tokenizer path until it lands; a failed load keeps that fallback for good.
	// Same skips as the token scan — fd dups (`2>&1`, `>&2`) and /dev/null are
	// not file writes, and empty targets are grammar-error fragments.
	void ensureBashAstLoaded();
	for (const redirect of parseBashAstSync(command)?.redirects ?? []) {
		if (!isBashAstWriteRedirect(redirect)) continue;
		const target = redirect.target;
		if (target.length === 0) continue;
		if (redirect.op.includes("&") && /^\d+$/.test(target)) continue;
		if (target === "/dev/null") continue;
		const result = validatePath(target, process.cwd(), options, "write");
		// CC parity: an out-of-working-dir redirect target asks in ask-preserving
		// modes but is allowed under bypassPermissions — except protected-path
		// writes (safetyCheck), which are bypass-immune regardless of command
		// form, matching how cp/touch to the same path still ask.
		if (
			!result.allowed &&
			(options.mode !== "bypassPermissions" || result.decisionReason?.type === "safetyCheck")
		) {
			return {
				behavior: "ask",
				message: t("Permission to write redirect target {{path}} has not been granted yet.", {
					path: target,
				}),
				decisionReason: pathReason(result.decisionReason),
				blockedPath: result.resolvedPath,
			};
		}
	}

	for (const tokens of segmentTokens) {
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			if (isFileRedirectTarget(tokens, i)) {
				const target = tokens[i + 1];
				const result = validatePath(target, process.cwd(), options, "write");
				// CC parity: an out-of-working-dir redirect target asks in ask-preserving
				// modes but is allowed under bypassPermissions — except protected-path
				// writes (safetyCheck), which are bypass-immune regardless of command
				// form, matching how cp/touch to the same path still ask.
				if (
					!result.allowed &&
					(options.mode !== "bypassPermissions" || result.decisionReason?.type === "safetyCheck")
				) {
					return {
						behavior: "ask",
						message: t("Permission to write redirect target {{path}} has not been granted yet.", {
							path: target,
						}),
						decisionReason: pathReason(result.decisionReason),
						blockedPath: result.resolvedPath,
					};
				}
				continue;
			}
			if (REMOVAL_COMMANDS.has(token)) {
				for (const arg of tokens.slice(i + 1)) {
					if (arg.startsWith("-")) continue;
					if (isDangerousRemovalPath(arg)) {
						return {
							behavior: "ask",
							message: t("Refusing to remove a dangerous path without confirmation: {{path}}.", { path: arg }),
							decisionReason: {
								type: "safetyCheck",
								reason: "dangerous removal target",
								classifierApprovable: false,
							},
							blockedPath: arg,
						};
					}
					const result = validatePath(arg, process.cwd(), options, "write");
					// Same CC parity as redirect targets: bypass mode allows
					// out-of-cwd removals — except protected paths (safetyCheck),
					// which stay bypass-immune (the dangerous-name gate above
					// also still asks).
					if (
						!result.allowed &&
						(options.mode !== "bypassPermissions" || result.decisionReason?.type === "safetyCheck")
					) {
						return {
							behavior: "ask",
							message: t("Permission to remove {{path}} has not been granted yet.", { path: arg }),
							decisionReason: pathReason(result.decisionReason),
							blockedPath: result.resolvedPath,
						};
					}
				}
			}
		}
	}

	// Path-command validation (CC PATH_EXTRACTORS engine): every filesystem
	// command in the chain gets its path arguments classified and validated.
	const cwd = process.cwd();
	for (const tokens of segmentTokens) {
		const result = validateSegmentCommandPaths(tokens, cwd, options, compoundHasCd);
		if (result) return result;
	}
	return undefined;
}

/** True when the segment redirects output to a real file target (not an fd dup). */
function hasFileRedirectTarget(tokens: string[]): boolean {
	for (let i = 0; i < tokens.length; i++) {
		if (isFileRedirectTarget(tokens, i, true)) return true;
	}
	return false;
}

function pathReason(reason: PermissionDecisionReason | undefined): PermissionDecisionReason {
	return reason ?? { type: "workingDir", reason: "Path is outside allowed working directories" };
}

/** `git commit …` → suggest `Bash(git commit:*)`; anything else → exact rule. */
function suggestBashRules(command: string) {
	const tokens = command.split(/\s+/).filter(Boolean);
	const first = tokens[0];
	const second = tokens[1];
	if (first && !BARE_SHELL_PREFIXES.has(first) && second && /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(second)) {
		return suggestionForPrefix("bash", `${first} ${second}`);
	}
	return suggestionForExactCommand("bash", command);
}
