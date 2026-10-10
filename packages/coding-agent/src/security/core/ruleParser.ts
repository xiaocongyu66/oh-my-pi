/**
 * Permission rule string parsing: `ToolName` / `ToolName(content)` with
 * escaped-parenthesis handling, ported from Claude Code's permission rule parser.
 *
 * Alias table maps Claude-Code-style PascalCase tool names (and legacy renames)
 * onto oh-my-pi's lowercase tool names so rules written CC-style still bind.
 */

import type { PermissionRuleValue } from "./types";

/** Canonical oh-my-pi tool names for rule strings written with other spellings. */
const TOOL_NAME_ALIASES: Record<string, string> = {
	// Claude Code PascalCase names → omp lowercase tool names
	Bash: "bash",
	Read: "read",
	Write: "write",
	Edit: "edit",
	MultiEdit: "edit",
	Glob: "glob",
	Grep: "grep",
	WebFetch: "web_fetch",
	WebSearch: "web_search",
	Agent: "task",
	Task: "task",
};

export function normalizeToolName(name: string): string {
	return TOOL_NAME_ALIASES[name] ?? name;
}

/** All spellings that resolve to the given canonical tool name. */
export function getAliasToolNames(canonicalName: string): string[] {
	const result: string[] = [];
	for (const [alias, canonical] of Object.entries(TOOL_NAME_ALIASES)) {
		if (canonical === canonicalName) result.push(alias);
	}
	return result;
}

/**
 * Escapes special characters in rule content for safe storage in permission
 * rules. Rules use the format "Tool(content)", so parentheses in content must
 * be escaped.
 *
 * Escaping order matters: backslashes first, then parentheses.
 */
export function escapeRuleContent(content: string): string {
	return content
		.replace(/\\/g, "\\\\") // Escape backslashes first
		.replace(/\(/g, "\\(") // Escape opening parentheses
		.replace(/\)/g, "\\)"); // Escape closing parentheses
}

/**
 * Reverses `escapeRuleContent`: parentheses first, backslashes last.
 */
export function unescapeRuleContent(content: string): string {
	return content
		.replace(/\\\(/g, "(") // Unescape opening parentheses
		.replace(/\\\)/g, ")") // Unescape closing parentheses
		.replace(/\\\\/g, "\\"); // Unescape backslashes last
}

/**
 * Parses a permission rule string into its components.
 *
 * Format: "ToolName" or "ToolName(content)"; content may contain escaped
 * parentheses (backslash-escaped). Empty or "*" content collapses to a tool-wide rule.
 *
 * @example
 * permissionRuleValueFromString("Bash(npm install)") // => { toolName: "bash", ruleContent: "npm install" }
 * permissionRuleValueFromString("Bash(python -c \"print\\(1\\)\")") // => { toolName: "bash", ruleContent: 'python -c "print(1)"' }
 */
export function permissionRuleValueFromString(ruleString: string): PermissionRuleValue {
	// Find the first unescaped opening parenthesis
	const openParenIndex = findFirstUnescapedChar(ruleString, "(");
	if (openParenIndex === -1) {
		// No parenthesis found - this is just a tool name
		return { toolName: normalizeToolName(ruleString) };
	}

	// Find the last unescaped closing parenthesis
	const closeParenIndex = findLastUnescapedChar(ruleString, ")");
	if (closeParenIndex === -1 || closeParenIndex <= openParenIndex) {
		// No matching closing paren or malformed - treat as tool name
		return { toolName: normalizeToolName(ruleString) };
	}

	// Ensure the closing paren is at the end
	if (closeParenIndex !== ruleString.length - 1) {
		// Content after closing paren - treat as tool name
		return { toolName: normalizeToolName(ruleString) };
	}

	const toolName = ruleString.substring(0, openParenIndex);
	const rawContent = ruleString.substring(openParenIndex + 1, closeParenIndex);

	// Missing toolName (e.g., "(foo)") is malformed - treat whole string as tool name
	if (!toolName) {
		return { toolName: normalizeToolName(ruleString) };
	}

	// Empty content (e.g., "Bash()") or standalone wildcard (e.g., "Bash(*)")
	// should be treated as just the tool name (tool-wide rule)
	if (rawContent === "" || rawContent === "*") {
		return { toolName: normalizeToolName(toolName) };
	}

	// Unescape the content
	const ruleContent = unescapeRuleContent(rawContent);
	return { toolName: normalizeToolName(toolName), ruleContent };
}

/**
 * Converts a permission rule value to its string representation, escaping
 * parentheses in the content to prevent parsing issues.
 */
export function permissionRuleValueToString(ruleValue: PermissionRuleValue): string {
	if (!ruleValue.ruleContent) {
		return ruleValue.toolName;
	}
	const escapedContent = escapeRuleContent(ruleValue.ruleContent);
	return `${ruleValue.toolName}(${escapedContent})`;
}

/**
 * Find the index of the first unescaped occurrence of a character.
 * A character is escaped if preceded by an odd number of backslashes.
 */
function findFirstUnescapedChar(str: string, char: string): number {
	for (let i = 0; i < str.length; i++) {
		if (str[i] === char) {
			let backslashCount = 0;
			let j = i - 1;
			while (j >= 0 && str[j] === "\\") {
				backslashCount++;
				j--;
			}
			if (backslashCount % 2 === 0) {
				return i;
			}
		}
	}
	return -1;
}

/**
 * Find the index of the last unescaped occurrence of a character.
 * A character is escaped if preceded by an odd number of backslashes.
 */
function findLastUnescapedChar(str: string, char: string): number {
	for (let i = str.length - 1; i >= 0; i--) {
		if (str[i] === char) {
			let backslashCount = 0;
			let j = i - 1;
			while (j >= 0 && str[j] === "\\") {
				backslashCount++;
				j--;
			}
			if (backslashCount % 2 === 0) {
				return i;
			}
		}
	}
	return -1;
}
