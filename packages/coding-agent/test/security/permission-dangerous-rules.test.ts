/**
 * Contract: allow rules that would auto-approve arbitrary code execution are
 * recognized and stripped for auto mode, then restored on exit — matching
 * Claude Code's permissionSetup.
 */
import { describe, expect, test } from "bun:test";
import {
	findDangerousAllowRules,
	isDangerousBashPermission,
	isDangerousClassifierPermission,
	isOverlyBroadBashAllowRule,
	isDangerousTaskPermission,
	restoreDangerousAllowRules,
	stripDangerousAllowRules,
} from "../../src/security/core/permissionSetup";
import type { ParsedRules, PermissionRule } from "../../src/security/core/types";

function allowRule(toolName: string, ruleContent?: string): PermissionRule {
	return {
		source: "project",
		ruleBehavior: "allow",
		ruleValue: ruleContent === undefined ? { toolName } : { toolName, ruleContent },
	};
}

function parsed(...allow: PermissionRule[]): ParsedRules {
	return { allow, deny: [], ask: [] };
}

describe("isDangerousBashPermission", () => {
	test("tool-wide and wildcard bash allows are dangerous", () => {
		expect(isDangerousBashPermission("bash", undefined)).toBe(true);
		expect(isDangerousBashPermission("bash", "")).toBe(true);
		expect(isDangerousBashPermission("bash", "*")).toBe(true);
	});

	for (const content of ["python", "python:*", "node*", "python *", "npm run *", "ssh:*", "deno:*"]) {
		test(`interpreter shape "${content}" is dangerous`, () => {
			expect(isDangerousBashPermission("bash", content)).toBe(true);
		});
	}

	test("interpreter flag-exec shapes are dangerous", () => {
		expect(isDangerousBashPermission("bash", "python -*")).toBe(true);
	});

	test("benign and non-bash rules are not dangerous", () => {
		expect(isDangerousBashPermission("bash", "git diff:*")).toBe(false);
		expect(isDangerousBashPermission("bash", "npm run test:*")).toBe(false);
		expect(isDangerousBashPermission("bash", "npm run build:*")).toBe(false);
		expect(isDangerousBashPermission("read", undefined)).toBe(false);
	});

	test("case is normalized", () => {
		expect(isDangerousBashPermission("bash", "Python:*")).toBe(true);
	});
});

describe("task delegation", () => {
	test("any task allow is dangerous", () => {
		expect(isDangerousTaskPermission("task")).toBe(true);
		expect(isDangerousTaskPermission("bash")).toBe(false);
		expect(isDangerousClassifierPermission("task", undefined)).toBe(true);
	});
});

test("isOverlyBroadBashAllowRule flags tool-wide bash allows", () => {
	expect(isOverlyBroadBashAllowRule({ toolName: "bash" })).toBe(true);
	expect(isOverlyBroadBashAllowRule({ toolName: "bash", ruleContent: "ls" })).toBe(false);
});

describe("strip / restore cycle", () => {
	const benign = allowRule("bash", "git status");
	const broadBash = allowRule("bash");
	const python = allowRule("bash", "python:*");
	const task = allowRule("task");

	test("finds exactly the dangerous allow rules", () => {
		const found = findDangerousAllowRules(parsed(benign, broadBash, python, task));
		expect(found).toHaveLength(3);
	});

	test("stripping removes them and stashing enables restore", () => {
		const original = parsed(benign, broadBash, python, task);
		const { rules, stripped } = stripDangerousAllowRules(original);
		expect(rules.allow).toEqual([benign]);
		expect(stripped).toHaveLength(3);

		const restored = restoreDangerousAllowRules(rules, stripped);
		expect(restored.allow).toHaveLength(4);
		expect(restored.allow).toContain(broadBash);
	});

	test("no-op stripping keeps the identical rule object", () => {
		const clean = parsed(benign);
		const result = stripDangerousAllowRules(clean);
		expect(result.rules).toBe(clean);
		expect(result.stripped).toEqual([]);
	});

	test("restoring twice does not duplicate entries", () => {
		const { rules, stripped } = stripDangerousAllowRules(parsed(broadBash, benign));
		const once = restoreDangerousAllowRules(rules, stripped);
		const twice = restoreDangerousAllowRules(once, stripped);
		expect(twice.allow).toHaveLength(2);
	});
});
