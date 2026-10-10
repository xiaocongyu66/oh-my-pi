/**
 * Contract: permission rule strings (`Tool`, `Tool(content)`, escaped parens,
 * wildcards, legacy `:*` prefixes) parse and match exactly like Claude Code's
 * rule syntax, with PascalCase names bound to the host's tool names.
 */
import { describe, expect, test } from "bun:test";
import {
	escapeRuleContent,
	getAliasToolNames,
	normalizeToolName,
	permissionRuleValueFromString,
	permissionRuleValueToString,
	unescapeRuleContent,
} from "../../src/security/core/ruleParser";
import {
	hasWildcards,
	matchWildcardPattern,
	parsePermissionRule,
	permissionRuleExtractPrefix,
	shellRuleMatchesInput,
	suggestionForExactCommand,
	suggestionForPrefix,
} from "../../src/security/core/shellRuleMatching";

describe("permissionRuleValueFromString", () => {
	test("parses tool + content with alias mapping", () => {
		expect(permissionRuleValueFromString("Bash(npm install)")).toEqual({
			toolName: "bash",
			ruleContent: "npm install",
		});
		expect(permissionRuleValueFromString("Read(./.env)")).toEqual({ toolName: "read", ruleContent: "./.env" });
	});

	test("bare tool name is a tool-wide rule", () => {
		expect(permissionRuleValueFromString("Bash")).toEqual({ toolName: "bash" });
		expect(permissionRuleValueFromString("web_fetch")).toEqual({ toolName: "web_fetch" });
	});

	test("empty or standalone wildcard content collapses to tool-wide", () => {
		expect(permissionRuleValueFromString("Bash()")).toEqual({ toolName: "bash" });
		expect(permissionRuleValueFromString("Bash(*)")).toEqual({ toolName: "bash" });
	});

	test("unescapes escaped parentheses in content", () => {
		expect(permissionRuleValueFromString(String.raw`Bash(python -c "print\(1\)")`)).toEqual({
			toolName: "bash",
			ruleContent: 'python -c "print(1)"',
		});
	});

	test("malformed shapes fall back to the whole string as tool name", () => {
		expect(permissionRuleValueFromString("Bash(").ruleContent).toBeUndefined();
		expect(permissionRuleValueFromString("(foo)").ruleContent).toBeUndefined();
		expect(permissionRuleValueFromString("Bash(a))b").ruleContent).toBeUndefined();
	});

	test("round-trips through string form", () => {
		const cases = ["git diff:*", "a(b)c", "back\\slash", "npm install"];
		for (const content of cases) {
			const value = { toolName: "bash", ruleContent: content };
			expect(permissionRuleValueFromString(permissionRuleValueToString(value))).toEqual(value);
		}
	});
});

describe("tool name aliases", () => {
	test("Claude Code PascalCase names map to host names", () => {
		expect(normalizeToolName("Bash")).toBe("bash");
		expect(normalizeToolName("MultiEdit")).toBe("edit");
		expect(normalizeToolName("WebFetch")).toBe("web_fetch");
		expect(normalizeToolName("Agent")).toBe("task");
		expect(normalizeToolName("unknown_tool")).toBe("unknown_tool");
	});

	test("alias lookup enumerates all spellings of a canonical name", () => {
		expect(getAliasToolNames("edit").sort()).toEqual(["Edit", "MultiEdit"]);
		expect(getAliasToolNames("nope")).toEqual([]);
	});
});

describe("escape/unescape symmetry", () => {
	test("backslash-heavy content survives a round trip", () => {
		for (const content of ["a\\(b", "a\\)b", "a\\\\b", String.raw`a\(nested\) \x`]) {
			expect(unescapeRuleContent(escapeRuleContent(content))).toBe(content);
		}
	});
});

describe("shell rule matching", () => {
	test("legacy :* syntax parses as a prefix rule", () => {
		expect(permissionRuleExtractPrefix("npm:*")).toBe("npm");
		expect(permissionRuleExtractPrefix("npm install")).toBeNull();
		expect(parsePermissionRule("git:*")).toEqual({ type: "prefix", prefix: "git" });
	});

	test("prefix rules match at whitespace boundaries only", () => {
		const rule = parsePermissionRule("git:*");
		expect(shellRuleMatchesInput(rule, "git")).toBe(true);
		expect(shellRuleMatchesInput(rule, "git add .")).toBe(true);
		expect(shellRuleMatchesInput(rule, "gitlab push")).toBe(false);
	});

	test("exact rules require equality", () => {
		const rule = parsePermissionRule("git status");
		expect(rule.type).toBe("exact");
		expect(shellRuleMatchesInput(rule, "git status")).toBe(true);
		expect(shellRuleMatchesInput(rule, "git status --short")).toBe(false);
	});

	test("single trailing-star wildcard treats the argument as optional", () => {
		const rule = parsePermissionRule("git *");
		expect(rule.type).toBe("wildcard");
		expect(shellRuleMatchesInput(rule, "git")).toBe(true);
		expect(shellRuleMatchesInput(rule, "git add x")).toBe(true);
		expect(shellRuleMatchesInput(rule, "gitk")).toBe(false);
	});

	test("multi-wildcard patterns require all segments", () => {
		expect(matchWildcardPattern("* run *", "npm run test")).toBe(true);
		expect(matchWildcardPattern("* run *", "npm run")).toBe(false);
	});

	test("escaped \\* matches a literal asterisk", () => {
		expect(matchWildcardPattern(String.raw`echo \*`, "echo *")).toBe(true);
		expect(matchWildcardPattern(String.raw`echo \*`, "echo anything")).toBe(false);
	});

	test("hasWildcards distinguishes :* from true wildcards", () => {
		expect(hasWildcards("git:*")).toBe(false);
		expect(hasWildcards("git *")).toBe(true);
		expect(hasWildcards(String.raw`git \*`)).toBe(false);
	});

	test("wildcards match across newlines (heredoc bodies)", () => {
		expect(matchWildcardPattern("cat *", "cat <<EOF\nline\nEOF")).toBe(true);
	});

	test("suggestions carry the rule into the project layer", () => {
		expect(suggestionForExactCommand("bash", "git status")).toEqual([
			{
				type: "addRules",
				rules: [{ toolName: "bash", ruleContent: "git status" }],
				behavior: "allow",
				destination: "project",
			},
		]);
		expect(suggestionForPrefix("bash", "npm run")).toEqual([
			{
				type: "addRules",
				rules: [{ toolName: "bash", ruleContent: "npm run:*" }],
				behavior: "allow",
				destination: "project",
			},
		]);
	});
});
