/**
 * Dangerous allow-rule detection and stripping for auto mode, ported from
 * Claude Code's permissionSetup. A rule is dangerous when it would auto-allow
 * arbitrary code execution before the classifier can evaluate it — tool-wide
 * bash allows and interpreter prefixes (`python:*`, `node*`, ...). Stripping
 * is in-memory with a stash so leaving auto mode restores the user's rules.
 */

import { DANGEROUS_BASH_PATTERNS } from "./dangerousPatterns";
import type { ParsedRules, PermissionRule, PermissionRuleValue } from "./types";

/**
 * Checks if a bash permission rule is dangerous for auto mode.
 *
 * Dangerous patterns:
 * 1. Tool-level allow (bash with no ruleContent) — allows ALL commands
 * 2. Prefix rules for script interpreters (python:*, node:*, etc.)
 * 3. Wildcard rules matching interpreters (python*, python *, python -*)
 */
export function isDangerousBashPermission(toolName: string, ruleContent: string | undefined): boolean {
	if (toolName !== "bash") {
		return false;
	}

	// Tool-level allow (bash with no content, or bash(*)) — allows ALL commands
	if (ruleContent === undefined || ruleContent === "") {
		return true;
	}

	const content = ruleContent.trim().toLowerCase();

	// Standalone wildcard (*) matches everything
	if (content === "*") {
		return true;
	}

	for (const pattern of DANGEROUS_BASH_PATTERNS) {
		const lowerPattern = pattern.toLowerCase();

		// Exact match to the pattern itself (e.g., "python" as a rule)
		if (content === lowerPattern) {
			return true;
		}
		// Prefix syntax: "python:*" allows any python command
		if (content === `${lowerPattern}:*`) {
			return true;
		}
		// Wildcard at end: "python*" matches python, python3, etc.
		if (content === `${lowerPattern}*`) {
			return true;
		}
		// Wildcard with space: "python *" matches "python script.py"
		if (content === `${lowerPattern} *`) {
			return true;
		}
		// "python -*" would match "python -c 'code'"
		if (content.startsWith(`${lowerPattern} -`) && content.endsWith("*")) {
			return true;
		}
	}

	return false;
}

/**
 * Any task (subagent) allow rule auto-approves agent spawns before a
 * classifier can evaluate the delegated prompt — delegation attacks.
 */
export function isDangerousTaskPermission(toolName: string): boolean {
	return toolName === "task";
}

/** True when an allow rule would bypass classifier evaluation. */
export function isDangerousClassifierPermission(toolName: string, ruleContent: string | undefined): boolean {
	return isDangerousBashPermission(toolName, ruleContent) || isDangerousTaskPermission(toolName);
}

/**
 * True for tool-level bash allow rules (bash, bash(*), bash()) — these allow
 * every bash command, which is effectively YOLO.
 */
export function isOverlyBroadBashAllowRule(ruleValue: PermissionRuleValue): boolean {
	return ruleValue.toolName === "bash" && ruleValue.ruleContent === undefined;
}

/** All allow rules that must not take effect in auto mode. */
export function findDangerousAllowRules(allowRules: PermissionRule[]): PermissionRule[] {
	return allowRules.filter(rule =>
		isDangerousClassifierPermission(rule.ruleValue.toolName, rule.ruleValue.ruleContent),
	);
}

export type StrippedRules = {
	rules: ParsedRules;
	/** Dangerous allow rules removed for auto mode; restore on exit. */
	stripped: PermissionRule[];
};

/**
 * Removes dangerous allow rules from a parsed rule set, returning the cleaned
 * rules plus the stash needed by `restoreDangerousAllowRules`.
 */
export function stripDangerousAllowRules(rules: ParsedRules): StrippedRules {
	const dangerous = findDangerousAllowRules(rules.allow);
	if (dangerous.length === 0) {
		return { rules, stripped: [] };
	}
	const dangerousKeys = new Set(dangerous.map(rule => ruleKey(rule)));
	return {
		rules: {
			...rules,
			allow: rules.allow.filter(rule => !dangerousKeys.has(ruleKey(rule))),
		},
		stripped: dangerous,
	};
}

/** Re-adds previously stashed dangerous allow rules. */
export function restoreDangerousAllowRules(rules: ParsedRules, stripped: PermissionRule[]): ParsedRules {
	if (stripped.length === 0) {
		return rules;
	}
	const existing = new Set(rules.allow.map(rule => ruleKey(rule)));
	const reAdd = stripped.filter(rule => !existing.has(ruleKey(rule)));
	if (reAdd.length === 0) {
		return rules;
	}
	return { ...rules, allow: [...rules.allow, ...reAdd] };
}

function ruleKey(rule: PermissionRule): string {
	return `${rule.ruleBehavior}\u0000${rule.ruleValue.toolName}\u0000${rule.ruleValue.ruleContent ?? ""}`;
}
