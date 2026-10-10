/**
 * Path validation entry points, ported from Claude Code's
 * `src/utils/permissions/pathValidation.ts`. `validatePath` is the single
 * funnel for bash-side path arguments (redirect targets, removal targets,
 * explicit file arguments): quote stripping, tilde/`$`/`%`/`=` TOCTOU
 * rejection, write-side glob rejection, then the ordered allow decision.
 *
 * Adaptations: no settings-source roots (cwd only), no sandbox write-allowlist
 * step (until the sandbox lands), no CC-internal editable/readable carve-outs.
 */

import * as os from "node:os";
import * as path from "node:path";
import {
	checkPathSafetyForAutoEdit,
	expandPath,
	getPathsForPermissionCheck,
	matchingPathRuleForInput,
	pathInAllowedWorkingPath,
	safeResolvePath,
	GLOB_PATTERN_REGEX,
} from "./pathSafety";
import type { ParsedRules, PermissionDecisionReason, PermissionMode } from "./types";

export type FileOperationType = "read" | "write" | "create";

export type PathPermissionOptions = {
	rules: ParsedRules;
	workingDirectories: Iterable<string>;
	mode: PermissionMode;
};

export type PathCheckResult = { allowed: boolean; decisionReason?: PermissionDecisionReason };
export type ResolvedPathCheckResult = PathCheckResult & { resolvedPath: string };

const READ_TOOL_NAMES: readonly string[] = ["read"];
const EDIT_TOOL_NAMES: readonly string[] = ["edit", "write"];

/** Expand `~`, `~/` (and `~\` on win32) only; `~user` stays literal. */
export function expandTilde(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	if (process.platform === "win32" && p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/** Directory portion before the first glob metacharacter. */
export function getGlobBaseDirectory(p: string): string {
	const match = GLOB_PATTERN_REGEX.exec(p);
	if (!match) return p;
	const beforeGlob = p.slice(0, match.index);
	const lastSep = Math.max(beforeGlob.lastIndexOf("/"), process.platform === "win32" ? beforeGlob.lastIndexOf("\\") : -1);
	if (lastSep === -1) return ".";
	return beforeGlob.substring(0, lastSep) || "/";
}

/** `'/a', '/b', and ${n-5} more` rendering for working-directory hints. */
export function formatDirectoryList(directories: readonly string[]): string {
	if (directories.length <= 5) return directories.map(dir => `'${dir}'`).join(", ");
	return `${directories
		.slice(0, 5)
		.map(dir => `'${dir}'`)
		.join(", ")}, and ${directories.length - 5} more`;
}

/** Ordered allow decision for an already-resolved absolute path. */
export function isPathAllowed(
	resolvedPath: string,
	options: PathPermissionOptions,
	operationType: FileOperationType,
	precomputedPathsToCheck?: string[],
): PathCheckResult {
	const toolNames = operationType === "read" ? READ_TOOL_NAMES : EDIT_TOOL_NAMES;
	const pathsToCheck = precomputedPathsToCheck ?? getPathsForPermissionCheck(resolvedPath);

	// 1. Deny rules over every representation.
	for (const p of pathsToCheck) {
		const denyRule = matchingPathRuleForInput(p, options.rules, "deny", toolNames);
		if (denyRule) return { allowed: false, decisionReason: { type: "rule", rule: denyRule } };
	}

	// 2. Writes pass the composite safety gate before working-directory and
	// allow-rule logic — an allow rule must not wave through a protected file.
	if (operationType !== "read") {
		const safety = checkPathSafetyForAutoEdit(resolvedPath, pathsToCheck);
		if (!safety.safe) {
			return {
				allowed: false,
				decisionReason: { type: "safetyCheck", reason: safety.message, classifierApprovable: safety.classifierApprovable },
			};
		}
	}

	// 3. Working-directory reads are free; writes need acceptEdits.
	if (pathInAllowedWorkingPath(resolvedPath, options.workingDirectories, pathsToCheck)) {
		if (operationType === "read" || options.mode === "acceptEdits") return { allowed: true };
	}

	// 4. Allow rules.
	const allowRule = matchingPathRuleForInput(resolvedPath, options.rules, "allow", toolNames);
	if (allowRule) return { allowed: true, decisionReason: { type: "rule", rule: allowRule } };

	return { allowed: false };
}

function checkWithResolution(absolutePath: string, options: PathPermissionOptions, operationType: FileOperationType): ResolvedPathCheckResult {
	const { resolvedPath, isCanonical } = safeResolvePath(absolutePath);
	const result = isPathAllowed(resolvedPath, options, operationType, isCanonical ? [resolvedPath] : undefined);
	return { ...result, resolvedPath };
}

/** Validate a glob pattern: reads check the base directory; writes are refused upstream. */
export function validateGlobPattern(
	cleanPath: string,
	cwd: string,
	options: PathPermissionOptions,
	operationType: FileOperationType,
): ResolvedPathCheckResult {
	let absolutePath: string;
	if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(cleanPath)) {
		absolutePath = path.isAbsolute(cleanPath) ? cleanPath : path.resolve(cwd, cleanPath);
	} else {
		const basePath = getGlobBaseDirectory(cleanPath);
		absolutePath = path.isAbsolute(basePath) ? basePath : path.resolve(cwd, basePath);
	}
	return checkWithResolution(absolutePath, options, operationType);
}

/**
 * Validate one path argument. Rejection reasons are surfaced as
 * `decisionReason.type: "other"` so the caller turns them into prompts, never
 * silent allows.
 */
export function validatePath(
	rawPath: string,
	cwd: string,
	options: PathPermissionOptions,
	operationType: FileOperationType,
): ResolvedPathCheckResult {
	const cleanPath = expandTilde(rawPath.replace(/^['"]|['"]$/g, ""));

	if (cleanPath.startsWith("//") || cleanPath.startsWith("\\\\")) {
		return {
			allowed: false,
			resolvedPath: cleanPath,
			decisionReason: { type: "other", reason: "UNC network paths require manual approval" },
		};
	}

	// Leftover `~` prefixes are ~user / ~+ / ~- variants the shell expands to a
	// different place than the literal path used for the check (TOCTOU class).
	if (cleanPath.startsWith("~")) {
		return {
			allowed: false,
			resolvedPath: cleanPath,
			decisionReason: { type: "other", reason: "Tilde expansion variants (~user, ~+, ~-) in paths require manual approval" },
		};
	}

	// `$VAR` / `${X}` / `$(cmd)` / `%VAR%` / zsh `=cmd` expand at execution
	// time but not during this check — another TOCTOU class.
	if (cleanPath.includes("$") || cleanPath.includes("%") || cleanPath.startsWith("=")) {
		return {
			allowed: false,
			resolvedPath: cleanPath,
			decisionReason: { type: "other", reason: "Shell expansion syntax in paths requires manual approval" },
		};
	}

	if (GLOB_PATTERN_REGEX.test(cleanPath)) {
		if (operationType === "write" || operationType === "create") {
			return {
				allowed: false,
				resolvedPath: cleanPath,
				decisionReason: {
					type: "other",
					reason: "Glob patterns are not allowed in write operations. Please specify an exact file path.",
				},
			};
		}
		return validateGlobPattern(cleanPath, cwd, options, operationType);
	}

	const absolutePath = expandPath(cleanPath, cwd);
	return checkWithResolution(absolutePath, options, operationType);
}
