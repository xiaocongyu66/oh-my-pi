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
 *
 * Unlike Claude Code's single-path `Edit`/`Write`, omp's `edit` payload can
 * write several paths (compound entries with renames, freeform apply_patch /
 * sloppy / hashline targets, ast_edit `paths`). CC's parity rule — every
 * written path must pass `checkWritePermissionForTool` — is kept by extracting
 * the full target list and folding the per-target results strictest-first
 * (deny → bypass-immune ask → reasoned ask → plain ask → allow).
 *
 * CC's `isClaudeConfigFilePath` is ported as the agent-config-file gate
 * (step 2.5): the agent's own settings layers prompt even under allow rules
 * and acceptEdits, over every symlink representation. This matters beyond the
 * dangerous-directory lists because `PI_CODING_AGENT_DIR` can relocate the
 * agent dir outside `.omp/`/`.claude/`.
 */

import { t } from "@oh-my-pi/pi-i18n";
import { getAgentDir } from "@oh-my-pi/pi-utils";

import {
	checkPathSafetyForAutoEdit,
	generatePathSuggestions,
	getPathsForPermissionCheck,
	GLOB_PATTERN_REGEX,
	isAgentConfigFilePath,
	matchingPathRuleForInput,
	pathInAllowedWorkingPath,
} from "./core/pathSafety";
import { getGlobBaseDirectory } from "./core/pathValidation";
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

const PASSTHROUGH = (toolName: string): PermissionResult => ({
	behavior: "passthrough",
	message: `Permission requested to use ${toolName}.`,
});

type PathOptions = {
	rules: ParsedRules;
	workingDirectories: string[];
	mode: PermissionMode;
	/** The agent's own config directory (`isAgentConfigFilePath` containment). */
	agentDir: string;
};

function pathOptions(ctx: PermissionCheckContext): PathOptions {
	return {
		rules: ctx.rules,
		workingDirectories: [process.cwd(), ...ctx.workingDirectories.keys()],
		mode: ctx.mode,
		agentDir: ctx.agentDir ?? getAgentDir(),
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

/**
 * Targets of a freeform edit payload (apply_patch / sloppy / hashline).
 * Deliberately a format-agnostic text scan rather than the native parser:
 * the security gate must not import the TUI module graph, and over-matching
 * is safe (an extra path only widens the check). Every `*** <verb> File:`
 * header, `*** Move to:` rename, `[path#TAG]` hashline section header, and
 * `MV dest` op contributes its literal path. A payload the scanner cannot
 * read yields no targets and falls back to the engine's passthrough plus the
 * tool's own native-inspect tier gate.
 */
const FREEFORM_FILE_HEADER = /^[ \t]*\*{3}[ \t]+(?:Add|Update|Edit|Delete)[ \t]+File:[ \t]*(.+?)[ \t]*$/gim;
const FREEFORM_MOVE_HEADER = /^[ \t]*\*{3}[ \t]+Move[ \t]+to:[ \t]*(.+?)[ \t]*$/gim;
const HASHLINE_SECTION_HEADER = /^\[([^[\]]+?)#[0-9a-fA-F]{4,}\]$/;

function unquotePath(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2) {
		const first = trimmed[0];
		const last = trimmed[trimmed.length - 1];
		if ((first === '"' || first === "'") && first === last) return trimmed.slice(1, -1).trim();
	}
	return trimmed;
}

function freeformEditTargets(input: string): string[] {
	const targets: string[] = [];
	for (const match of input.matchAll(FREEFORM_FILE_HEADER)) targets.push(unquotePath(match[1]));
	for (const match of input.matchAll(FREEFORM_MOVE_HEADER)) targets.push(unquotePath(match[1]));
	for (const rawLine of input.split("\n")) {
		const trimmed = rawLine.trim();
		if (trimmed.startsWith("[")) {
			const header = HASHLINE_SECTION_HEADER.exec(trimmed);
			if (header) targets.push(unquotePath(header[1]));
		} else if (/^MV[ \t]/.test(trimmed)) {
			targets.push(unquotePath(trimmed.slice(2)));
		}
	}
	return targets.filter(target => target.length > 0);
}

/**
 * Every filesystem path a write-tool payload touches. `edit` payloads may
 * carry extra targets beyond the primary path: compound entries with their
 * own `path`/`rename`, and freeform apply_patch/sloppy/hashline bodies whose
 * targets (including `*** Move to:` / `MV` renames) only exist inside the
 * `input` text. Internal-URL targets are excluded — the engine judges
 * filesystem paths; URL schemes keep their handler-owned tiers.
 */
function writeTargets(toolName: string, input: Record<string, unknown>): string[] {
	const targets: string[] = [];
	if (toolName === "edit" && typeof input.input === "string" && input.input.length > 0) {
		targets.push(...freeformEditTargets(input.input));
	}
	const primary = extractPath(input);
	if (primary !== undefined && !isNonFileSystemPath(primary)) targets.unshift(primary);
	if (toolName === "edit" && Array.isArray(input.edits)) {
		for (const entry of input.edits) {
			if (entry === null || typeof entry !== "object") continue;
			const record = entry as Record<string, unknown>;
			if (typeof record.path === "string" && record.path.length > 0) targets.push(record.path);
			if (typeof record.rename === "string" && record.rename.length > 0) targets.push(record.rename);
		}
	}
	if (toolName === "ast_edit" && Array.isArray(input.paths)) {
		for (const entry of input.paths) {
			if (typeof entry !== "string" || entry.length === 0 || isNonFileSystemPath(entry)) continue;
			// A glob target gates on its base directory without refusing the
			// write — ast_edit is the designed glob-rewrite tool.
			targets.push(GLOB_PATTERN_REGEX.test(entry) ? getGlobBaseDirectory(entry) : entry);
		}
	}
	return [...new Set(targets.filter(target => !isNonFileSystemPath(target)))];
}

export function checkFileToolPermission(
	toolName: string,
	input: Record<string, unknown>,
	ctx: PermissionCheckContext,
): PermissionResult {
	const options = pathOptions(ctx);
	if (READ_TOOLS.has(toolName)) {
		const rawPath = extractPath(input);
		if (rawPath === undefined || isNonFileSystemPath(rawPath)) return PASSTHROUGH(toolName);
		return checkReadPath(rawPath, toolName, options);
	}
	if (WRITE_TOOLS.has(toolName)) {
		const targets = writeTargets(toolName, input);
		if (targets.length === 0) return PASSTHROUGH(toolName);
		const writeBucket = [...new Set([...WRITE_BUCKET, toolName])];
		const results = targets.map(target => checkWritePathInternal(target, writeBucket, options));
		return results.length === 1 ? results[0] : strictestWriteResult(results);
	}
	return PASSTHROUGH(toolName);
}

/**
 * Fold per-target write results: a deny wins outright; among asks the
 * bypass-immune reasons (safetyCheck, explicit ask rule) win over plain
 * prompts, and a reasoned prompt wins over an unremarkable one so the engine
 * never downgrades a target's ask into a defer-to-tier passthrough; allow
 * only when every target allows.
 */
function strictestWriteResult(results: PermissionResult[]): PermissionResult {
	for (const result of results) {
		if (result.behavior === "deny") return result;
	}
	for (const reasonType of ["safetyCheck", "rule"] as const) {
		const found = results.find(result => result.behavior === "ask" && result.decisionReason?.type === reasonType);
		if (found) return found;
	}
	const reasonedAsk = results.find(result => result.behavior === "ask" && result.decisionReason !== undefined);
	if (reasonedAsk) return reasonedAsk;
	return results.find(result => result.behavior === "ask") ?? results[0];
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

	// 2.5. The agent's own configuration files (CC's isClaudeConfigFilePath
	// parity): always ask, even under allow rules and acceptEdits. Checked over
	// every symlink representation — the agent dir is relocatable via
	// PI_CODING_AGENT_DIR, so its config files need not sit under `.omp/`.
	const configTarget = pathsToCheck.find(path => isAgentConfigFilePath(path, options.agentDir));
	if (configTarget !== undefined) {
		const message = t(
			"Permission to write to {{path}}, which is an agent configuration file, has not been granted yet.",
			{ path: rawPath },
		);
		return {
			behavior: "ask",
			message,
			decisionReason: { type: "safetyCheck", reason: message, classifierApprovable: true },
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
