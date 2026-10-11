/**
 * Bash tool permission check, porting the legacy (non-AST) core of Claude
 * Code's `bashToolHasPermission`: split the command into subcommands, match
 * deny/ask/allow content rules per segment (deny anywhere wins), keep the
 * injection/security heuristics and path constraints in front of any allow,
 * auto-approve fully read-only commands, and emit "always allow" suggestions.
 *
 * Adaptations: segmentation uses the host tokenizer (`tools/shell-tokenize`);
 * CC's AST/two-stage async gates, sandbox and classifier hooks are omitted.
 */

import { t } from "@oh-my-pi/pi-i18n";
import { stripSafeWrappers } from "./core/safeCommandStrip";
import { tokenizeShellSegments } from "../tools/shell-tokenize";
import { bashCommandIsSafe } from "./bash-security";
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
	// misparsed wrapper would approve an unseen body. Deferred non-misparsing
	// asks (redirections, newlines, …) are dropped here — their surface is
	// covered by the path-constraint step below and by rule/mode flow, matching
	// CC's early-block-only consumer.
	const safety = bashCommandIsSafe(command);
	if (safety.behavior === "ask" && safety.isBashSecurityCheckForMisparsing) {
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

	// 5. Path constraints: redirect targets and removal arguments are file
	// operations in disguise.
	const pathResult = checkPathConstraints(segmentTokens, options);
	if (pathResult) return pathResult;

	// 6. Per-segment allow / ask rule collection (wrapper-stripped fallback, as
	// in steps 1-2).
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

	// 7. Read-only auto-approval is deliberately NOT ported from CC step 7:
	// the host treats bash as exec-tier and prompts on it in every
	// ask-preserving mode, and auto-allowing here would smuggle exec commands
	// past that posture. Commands fall through to the mode/tier flow instead.

	// 8. Nothing said allow: defer to the mode flow with an always-allow
	// suggestion (prefix when it names a meaningful subcommand).
	return {
		behavior: "passthrough",
		message: t("Permission requested to run this command."),
		suggestions: suggestBashRules(segments[0] ?? command),
	};
}

function checkPathConstraints(segmentTokens: string[][], options: PathOptions): PermissionResult | undefined {
	for (const tokens of segmentTokens) {
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			if (token === ">" || token === ">>" || token === ">&") {
				const target = tokens[i + 1];
				if (!target || target.startsWith("&") || /^\d+$/.test(target)) continue;
				const result = validatePath(target, process.cwd(), options, "write");
				// CC parity: an out-of-working-dir redirect target asks in ask-preserving
				// modes but is allowed under bypassPermissions (only bypass-immune
				// safetyChecks survive bypass there).
				if (!result.allowed && options.mode !== "bypassPermissions") {
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
					// out-of-cwd removals (the dangerous-name gate above still asks).
					if (!result.allowed && options.mode !== "bypassPermissions") {
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
	return undefined;
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
