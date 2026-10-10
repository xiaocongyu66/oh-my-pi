/**
 * Shared permission rule matching utilities for shell tools, ported from
 * Claude Code: exact / legacy prefix (`x:*`) / wildcard (`*`) rule shapes and
 * the corresponding matchers.
 */

import type { PermissionUpdate } from "./types";

// Null-byte sentinel placeholders for wildcard pattern escaping — module-level
// so the RegExp objects are compiled once instead of per permission check.
const ESCAPED_STAR_PLACEHOLDER = "\x00ESCAPED_STAR\x00";
const ESCAPED_BACKSLASH_PLACEHOLDER = "\x00ESCAPED_BACKSLASH\x00";
const ESCAPED_STAR_PLACEHOLDER_RE = new RegExp(ESCAPED_STAR_PLACEHOLDER, "g");
const ESCAPED_BACKSLASH_PLACEHOLDER_RE = new RegExp(ESCAPED_BACKSLASH_PLACEHOLDER, "g");

/**
 * Parsed permission rule discriminated union.
 */
export type ShellPermissionRule =
	| {
			type: "exact";
			command: string;
	  }
	| {
			type: "prefix";
			prefix: string;
	  }
	| {
			type: "wildcard";
			pattern: string;
	  };

/**
 * Extract prefix from legacy :* syntax (e.g., "npm:*" -> "npm").
 * Maintained for backwards compatibility with CC-style rules.
 */
export function permissionRuleExtractPrefix(permissionRule: string): string | null {
	const match = permissionRule.match(/^(.+):\*$/);
	return match?.[1] ?? null;
}

/**
 * Check if a pattern contains unescaped wildcards (not legacy :* syntax).
 * Returns true if the pattern contains * that are not escaped with \ or part
 * of :* at the end.
 */
export function hasWildcards(pattern: string): boolean {
	// If it ends with :*, it's legacy prefix syntax, not wildcard
	if (pattern.endsWith(":*")) {
		return false;
	}
	// An asterisk is unescaped if it's not preceded by a backslash, or if it's
	// preceded by an even number of backslashes (escaped backslashes consume
	// each other pairwise).
	for (let i = 0; i < pattern.length; i++) {
		if (pattern[i] === "*") {
			let backslashCount = 0;
			let j = i - 1;
			while (j >= 0 && pattern[j] === "\\") {
				backslashCount++;
				j--;
			}
			if (backslashCount % 2 === 0) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Match a command against a wildcard pattern.
 * Wildcards (`*`) match any sequence of characters.
 * Use `\*` to match a literal asterisk character. Use `\\` for a literal backslash.
 */
export function matchWildcardPattern(pattern: string, command: string, caseInsensitive = false): boolean {
	// Trim leading/trailing whitespace from pattern
	const trimmedPattern = pattern.trim();

	// Process the pattern to handle escape sequences: \* and \\
	let processed = "";
	let i = 0;

	while (i < trimmedPattern.length) {
		const char = trimmedPattern[i];

		if (char === "\\" && i + 1 < trimmedPattern.length) {
			const nextChar = trimmedPattern[i + 1];
			if (nextChar === "*") {
				// \* -> literal asterisk placeholder
				processed += ESCAPED_STAR_PLACEHOLDER;
				i += 2;
				continue;
			} else if (nextChar === "\\") {
				// \\ -> literal backslash placeholder
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

	// Convert unescaped * to .* for wildcard matching
	const withWildcards = escaped.replace(/\*/g, ".*");

	// Convert placeholders back to escaped regex literals
	let regexPattern = withWildcards
		.replace(ESCAPED_STAR_PLACEHOLDER_RE, "\\*")
		.replace(ESCAPED_BACKSLASH_PLACEHOLDER_RE, "\\\\");

	// When a pattern ends with ' *' (space + unescaped wildcard) AND the trailing
	// wildcard is the ONLY unescaped wildcard, make the trailing space-and-args
	// optional so 'git *' matches both 'git add' and bare 'git'. This aligns
	// wildcard matching with prefix rule semantics (git:*). Multi-wildcard
	// patterns like '* run *' are excluded — making the last wildcard optional
	// would incorrectly match 'npm run' (no trailing arg).
	const unescapedStarCount = (processed.match(/\*/g) || []).length;
	if (regexPattern.endsWith(" .*") && unescapedStarCount === 1) {
		regexPattern = regexPattern.slice(0, -3) + "( .*)?";
	}

	// Full-string match. The dotAll flag lets '.' match newlines so wildcards
	// match commands containing embedded newlines (e.g. heredoc content).
	const flags = "s" + (caseInsensitive ? "i" : "");
	const regex = new RegExp(`^${regexPattern}$`, flags);

	return regex.test(command);
}

/**
 * Parse a permission rule string into a structured rule object.
 */
export function parsePermissionRule(permissionRule: string): ShellPermissionRule {
	// Check for legacy :* prefix syntax first (backwards compatibility)
	const prefix = permissionRuleExtractPrefix(permissionRule);
	if (prefix !== null) {
		return {
			type: "prefix",
			prefix,
		};
	}

	// Check for new wildcard syntax (contains * but not :* at end)
	if (hasWildcards(permissionRule)) {
		return {
			type: "wildcard",
			pattern: permissionRule,
		};
	}

	// Otherwise, it's an exact match
	return {
		type: "exact",
		command: permissionRule,
	};
}

/**
 * Check whether a rule content matches a concrete input under the parsed rule
 * shape: exact equality, prefix + whitespace boundary, or wildcard match.
 */
export function shellRuleMatchesInput(rule: ShellPermissionRule, input: string, caseInsensitive = false): boolean {
	switch (rule.type) {
		case "exact":
			return input === rule.command;
		case "prefix":
			return input === rule.prefix || input.startsWith(`${rule.prefix} `);
		case "wildcard":
			return matchWildcardPattern(rule.pattern, input, caseInsensitive);
	}
}

/**
 * Generate the permission update that "always allow this exact command" applies.
 */
export function suggestionForExactCommand(toolName: string, command: string): PermissionUpdate[] {
	return [
		{
			type: "addRules",
			rules: [{ toolName, ruleContent: command }],
			behavior: "allow",
			destination: "project",
		},
	];
}

/**
 * Generate the permission update that "always allow this command prefix" applies.
 */
export function suggestionForPrefix(toolName: string, prefix: string): PermissionUpdate[] {
	return [
		{
			type: "addRules",
			rules: [{ toolName, ruleContent: `${prefix}:*` }],
			behavior: "allow",
			destination: "project",
		},
	];
}
