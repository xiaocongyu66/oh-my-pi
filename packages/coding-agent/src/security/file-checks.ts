/**
 * Path-based tool permission checks for the file tools, porting the ordered
 * logic of Claude Code's `checkReadPermissionForTool` /
 * `checkWritePermissionForTool`. Registered into the tool-check dispatch so
 * rule content like `Read(./.env)` or `Edit(~/.ssh/**)` binds at step 1c of
 * the decision flow.
 *
 * Read family: UNC → suspicious-Windows → read deny → read ask →
 * (edit implies read) → inside working dir → read allow → ask.
 * Write family: edit deny → safety gate (bypass-immune) → edit ask →
 * acceptEdits-in-cwd → edit allow → ask.
 */

import { t } from "@oh-my-pi/pi-i18n";

import {
	checkPathSafetyForAutoEdit,
	generatePathSuggestions,
	getPathsForPermissionCheck,
	matchingPathRuleForInput,
	pathInAllowedWorkingPath,
} from "./core/pathSafety";
import type {
	ParsedRules,
	PermissionCheckContext,
	PermissionDecision,
	PermissionMode,
	PermissionResult,
} from "./core/types";

const READ_TOOLS = new Set(["read", "glob", "grep", "find", "list"]);
const WRITE_TOOLS = new Set(["edit", "write", "ast_edit", "notebook_edit"]);

const READ_BUCKET: readonly string[] = ["read"];
const WRITE_BUCKET: readonly string[] = ["edit", "write"];

type PathOptions = { rules: ParsedRules; workingDirectories: string[]; mode: PermissionMode };

function pathOptions(ctx: PermissionCheckContext): PathOptions {
	return {
		rules: ctx.rules,
		workingDirectories: [process.cwd(), ...ctx.workingDirectories.keys()],
		mode: ctx.mode,
	};
}

/** Filesystem path argument of a tool input, or undefined for non-path tools. */
function extractPath(input: Record<string, unknown>): string | undefined {
	for (const key of ["path", "file_path", "notebook_path"]) {
		const value = input[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

/** `https://…` / internal URIs are not filesystem paths; skip path rules. */
function isNonFileSystemPath(value: string): boolean {
	return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
}

export function checkFileToolPermission(
	toolName: string,
	input: Record<string, unknown>,
	ctx: PermissionCheckContext,
): PermissionResult {
	const rawPath = extractPath(input);
	if (rawPath === undefined) {
		return { behavior: "passthrough", message: `Permission requested to use ${toolName}.` };
	}
	if (isNonFileSystemPath(rawPath)) {
		return { behavior: "passthrough", message: `Permission requested to use ${toolName}.` };
	}
	const options = pathOptions(ctx);
	if (READ_TOOLS.has(toolName)) return checkReadPath(rawPath, toolName, options);
	if (WRITE_TOOLS.has(toolName)) return checkWritePath(rawPath, toolName, options);
	return { behavior: "passthrough", message: `Permission requested to use ${toolName}.` };
}

function checkReadPath(rawPath: string, toolName: string, options: PathOptions): PermissionResult {
	const readBucket = [...new Set([...READ_BUCKET, toolName])];
	const writeBucket = [...new Set([...WRITE_BUCKET, toolName])];
	const pathsToCheck = getPathsForPermissionCheck(rawPath);

	// 1. UNC defense-in-depth before any rule evaluation.
	if (rawPath.startsWith("//") || rawPath.startsWith("\\\\")) {
		return {
			behavior: "ask",
			message: `Permission to read from ${rawPath}, which appears to be a UNC path that could access network resources.`,
			decisionReason: { type: "other", reason: "UNC path detected (defense-in-depth check)" },
			blockedPath: rawPath,
		};
	}

	// 2. Read-specific deny over every representation — before the
	// edit-implies-read step so an explicit read deny can never be bypassed.
	for (const p of pathsToCheck) {
		const denyRule = matchingPathRuleForInput(p, options.rules, "deny", readBucket);
		if (denyRule) {
			return {
				behavior: "deny",
				message: t("Permission to read {{path}} has been denied.", { path: rawPath }),
				decisionReason: { type: "rule", rule: denyRule },
			};
		}
	}

	// 3. Read-specific ask rules.
	for (const p of pathsToCheck) {
		const askRule = matchingPathRuleForInput(p, options.rules, "ask", readBucket);
		if (askRule) {
			return {
				behavior: "ask",
				message: t("Permission to read from {{path}} has not been granted yet.", { path: rawPath }),
				decisionReason: { type: "rule", rule: askRule },
				blockedPath: rawPath,
			};
		}
	}

	// 4. Edit permission implies read permission.
	const writeResult = checkWritePathInternal(rawPath, writeBucket, options, pathsToCheck);
	if (writeResult.behavior === "allow") return writeResult as PermissionDecision;

	// 5. Inside the working directories reads are free.
	if (pathInAllowedWorkingPath(rawPath, options.workingDirectories, pathsToCheck)) {
		return { behavior: "allow", decisionReason: { type: "mode", mode: "default" } };
	}

	// 6. Read allow rules.
	const allowRule = matchingPathRuleForInput(rawPath, options.rules, "allow", readBucket);
	if (allowRule) {
		return { behavior: "allow", decisionReason: { type: "rule", rule: allowRule } };
	}

	// 7. Outside everything: prompt with grant-access suggestions.
	return {
		behavior: "ask",
		message: `Permission to read from ${rawPath} has not been granted yet.`,
		decisionReason: { type: "workingDir", reason: "Path is outside allowed working directories" },
		blockedPath: rawPath,
		suggestions: generatePathSuggestions(rawPath, "read", options, pathsToCheck),
	};
}

function checkWritePath(rawPath: string, toolName: string, options: PathOptions): PermissionResult {
	return checkWritePathInternal(rawPath, [...new Set([...WRITE_BUCKET, toolName])], options);
}

function checkWritePathInternal(
	rawPath: string,
	writeBucket: readonly string[],
	options: PathOptions,
	precomputed?: string[],
): PermissionResult {
	const pathsToCheck = precomputed ?? getPathsForPermissionCheck(rawPath);

	// 1. Edit deny rules over every representation.
	for (const p of pathsToCheck) {
		const denyRule = matchingPathRuleForInput(p, options.rules, "deny", writeBucket);
		if (denyRule) {
			return {
				behavior: "deny",
				message: t("Permission to edit {{path}} has been denied.", { path: rawPath }),
				decisionReason: { type: "rule", rule: denyRule },
			};
		}
	}

	// 2. Safety gate BEFORE allow rules and mode — protected paths must
	// prompt even under a broad allow rule or acceptEdits.
	const safety = checkPathSafetyForAutoEdit(rawPath, pathsToCheck);
	if (!safety.safe) {
		return {
			behavior: "ask",
			message: safety.message,
			decisionReason: {
				type: "safetyCheck",
				reason: safety.message,
				classifierApprovable: safety.classifierApprovable,
			},
			blockedPath: rawPath,
			suggestions: generatePathSuggestions(rawPath, "write", options, pathsToCheck),
		};
	}

	// 3. Edit ask rules.
	for (const p of pathsToCheck) {
		const askRule = matchingPathRuleForInput(p, options.rules, "ask", writeBucket);
		if (askRule) {
			return {
				behavior: "ask",
				message: t("Permission to write to {{path}} has not been granted yet.", { path: rawPath }),
				decisionReason: { type: "rule", rule: askRule },
				blockedPath: rawPath,
			};
		}
	}

	const inWorkingDir = pathInAllowedWorkingPath(rawPath, options.workingDirectories, pathsToCheck);

	// 4. acceptEdits approves workspace writes.
	if (options.mode === "acceptEdits" && inWorkingDir) {
		return { behavior: "allow", decisionReason: { type: "mode", mode: "acceptEdits" } };
	}

	// 5. Edit allow rules.
	const allowRule = matchingPathRuleForInput(rawPath, options.rules, "allow", writeBucket);
	if (allowRule) {
		return { behavior: "allow", decisionReason: { type: "rule", rule: allowRule } };
	}

	// 6. Prompt; outside the workspace carries the workingDir reason.
	return {
		behavior: "ask",
		message: `Permission to write to ${rawPath} has not been granted yet.`,
		...(inWorkingDir
			? {}
			: { decisionReason: { type: "workingDir", reason: "Path is outside allowed working directories" } as const }),
		blockedPath: rawPath,
		suggestions: generatePathSuggestions(rawPath, "write", options, pathsToCheck),
	};
}
