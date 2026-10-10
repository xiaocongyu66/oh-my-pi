/**
 * Turns settings rule-string arrays into parsed PermissionRules, ported from
 * Claude Code's permissionsLoader (string-parsing half only — persistence is
 * owned by the host settings system).
 */

import { permissionRuleValueFromString } from "./ruleParser";
import type { ParsedRules, PermissionBehavior, PermissionRule, PermissionRuleSource } from "./types";

export type RuleLayer = {
	source: PermissionRuleSource;
	allow?: readonly string[];
	deny?: readonly string[];
	ask?: readonly string[];
};

function parseBehaviorRules(
	strings: readonly string[] | undefined,
	behavior: PermissionBehavior,
	source: PermissionRuleSource,
): PermissionRule[] {
	if (!strings) {
		return [];
	}
	const rules: PermissionRule[] = [];
	for (const ruleString of strings) {
		const trimmed = typeof ruleString === "string" ? ruleString.trim() : "";
		if (trimmed.length === 0) {
			continue;
		}
		rules.push({
			source,
			ruleBehavior: behavior,
			ruleValue: permissionRuleValueFromString(trimmed),
		});
	}
	return rules;
}

/**
 * Parse every configured layer into behavior-grouped rules. Later layers do
 * not override earlier ones — deny/ask/allow precedence is behavioral
 * (deny is evaluated before ask before allow), source is metadata only.
 */
export function collectPermissionRules(layers: readonly RuleLayer[]): ParsedRules {
	const allow: PermissionRule[] = [];
	const deny: PermissionRule[] = [];
	const ask: PermissionRule[] = [];
	for (const layer of layers) {
		allow.push(...parseBehaviorRules(layer.allow, "allow", layer.source));
		deny.push(...parseBehaviorRules(layer.deny, "deny", layer.source));
		ask.push(...parseBehaviorRules(layer.ask, "ask", layer.source));
	}
	return { allow, deny, ask };
}

/** Single effective-layer shortcut used when the host flattens provenance itself. */
export function parsedRulesFromEffective(
	allow: readonly string[] | undefined = undefined,
	deny: readonly string[] | undefined = undefined,
	ask: readonly string[] | undefined = undefined,
	source: PermissionRuleSource = "project",
): ParsedRules {
	return collectPermissionRules([{ source, allow, deny, ask }]);
}

export const EMPTY_RULES: ParsedRules = { allow: [], deny: [], ask: [] };
