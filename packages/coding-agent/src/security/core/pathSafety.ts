/**
 * Path-safety primitives for file tools, ported from Claude Code's
 * `src/utils/permissions/filesystem.ts`. Covers the dangerous file/directory
 * lists, symlink-chain resolution with symmetric boundaries, suspicious
 * Windows path-pattern detection, working-directory containment, and the
 * gitignore-style content rules (`Edit(~/.ssh/**)`, `Read(./.env)`) that the
 * decision flow's tool checks consume.
 *
 * Adaptations from Claude Code: settings root is the host cwd (single rule
 * source); CC-internal path carve-outs (plans, scratchpad, tool results,
 * agent memory) are not ported; the `.claude/worktrees` exemption is dropped.
 * This module must stay free of imports outside `./` and Node builtins.
 */

import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { posix } from "node:path";
import type { ParsedRules, PermissionRule } from "./types";

// ============================================================================
// Constants
// ============================================================================

/** Files whose names alone mark them as sensitive edit targets, anywhere. */
export const DANGEROUS_FILES: readonly string[] = [
	".gitconfig",
	".gitmodules",
	".bashrc",
	".bash_profile",
	".zshrc",
	".zprofile",
	".profile",
	".ripgreprc",
	".mcp.json",
	".claude.json",
];

/** Directory segments that mark everything under them as sensitive. */
export const DANGEROUS_DIRECTORIES: readonly string[] = [".git", ".vscode", ".idea", ".claude", ".omp"];

/**
 * Basenames of the agent's own configuration layers (CC's settings.json /
 * settings.local.json parity). The agent dir is relocatable via
 * `PI_CODING_AGENT_DIR`, so its config files need not sit under a dangerous
 * directory segment — `isAgentConfigFilePath` closes that gap.
 */
export const AGENT_CONFIG_FILENAMES: readonly string[] = [
	"config.yml",
	"config.yaml",
	"settings.json",
	"settings.local.json",
];

export const GLOB_PATTERN_REGEX = /[*?[\]{}]/;

const WINDOWS_DRIVE_ROOT_REGEX = /^[A-Za-z]:\/?$/;
const WINDOWS_DRIVE_CHILD_REGEX = /^[A-Za-z]:\/[^/]+$/;

// ============================================================================
// Path helpers
// ============================================================================

/** Case-normalization for comparisons — lowercase on every platform. */
export function normalizeCaseForComparison(p: string): string {
	return p.toLowerCase();
}

/** True when the path contains a `..` traversal segment. */
export function containsPathTraversal(p: string): boolean {
	return /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(p);
}

/** Expand `~` / `~/` and resolve against baseDir; NFC-normalized. */
export function expandPath(inputPath: string, baseDir: string = process.cwd()): string {
	if (inputPath.includes("\0") || baseDir.includes("\0")) {
		throw new Error("Path contains null byte");
	}
	const trimmed = inputPath.trim();
	if (trimmed.length === 0) {
		return path.normalize(baseDir).normalize("NFC");
	}
	if (trimmed === "~") {
		return os.homedir().normalize("NFC");
	}
	if (trimmed.startsWith("~/")) {
		return path.join(os.homedir(), trimmed.slice(2)).normalize("NFC");
	}
	const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(baseDir, trimmed);
	return path.normalize(resolved).normalize("NFC");
}

/** POSIX-style relative path (separator-normalized), used for rule matching. */
export function relativePath(from: string, to: string): string {
	return posix.relative(toPosix(from), toPosix(to));
}

function toPosix(p: string): string {
	return p.replace(/\\/g, "/");
}

// ============================================================================
// Symlink-aware resolution
// ============================================================================

export type ResolvedPath = { resolvedPath: string; isSymlink: boolean; isCanonical: boolean };

/** Lexically resolve, following symlinks when possible; never throws. */
export function safeResolvePath(filePath: string): ResolvedPath {
	if (filePath.startsWith("//") || filePath.startsWith("\\\\")) {
		return { resolvedPath: filePath, isSymlink: false, isCanonical: false };
	}
	try {
		const stats = lstatSync(filePath);
		// realpathSync would block on FIFOs/sockets; exotic types are passed through.
		if (!stats.isSymbolicLink() && !stats.isFile() && !stats.isDirectory()) {
			return { resolvedPath: filePath, isSymlink: false, isCanonical: false };
		}
		const resolved = realpathSync(filePath);
		return { resolvedPath: resolved, isSymlink: resolved !== filePath, isCanonical: true };
	} catch {
		return { resolvedPath: filePath, isSymlink: false, isCanonical: false };
	}
}

/**
 * Every representation of a path that permission checks must consider: the
 * literal, every hop of its symlink chain (including dangling links and
 * symlinked ancestors), and the final realpath. UNC paths short-circuit
 * before any filesystem access (DNS/SMB leak defense on Windows).
 */
export function getPathsForPermissionCheck(inputPath: string): string[] {
	const result: string[] = [];
	let current = inputPath;
	if (current === "~") current = os.homedir().normalize("NFC");
	else if (current.startsWith("~/")) current = path.join(os.homedir(), current.slice(2)).normalize("NFC");
	result.push(current);

	if (current.startsWith("//") || current.startsWith("\\\\")) {
		return result;
	}

	const visited = new Set<string>();
	let maxDepth = 40;
	let linkPath = current;
	while (maxDepth-- > 0) {
		if (visited.has(linkPath)) break;
		visited.add(linkPath);
		if (!existsSync(linkPath)) {
			const deepest = resolveDeepestExistingAncestor(linkPath);
			if (deepest && deepest !== linkPath) result.push(deepest);
			break;
		}
		let stats: ReturnType<typeof lstatSync>;
		try {
			stats = lstatSync(linkPath);
		} catch {
			break;
		}
		if (stats.isFIFO() || stats.isSocket() || stats.isCharacterDevice() || stats.isBlockDevice()) break;
		if (!stats.isSymbolicLink()) break;
		let target: string;
		try {
			target = readlinkSync(linkPath);
		} catch {
			break;
		}
		if (!path.isAbsolute(target)) {
			target = path.resolve(path.dirname(linkPath), target);
		}
		if (!result.includes(target)) result.push(target);
		linkPath = target;
	}

	const canonical = safeResolvePath(current);
	if (canonical.isCanonical && canonical.resolvedPath !== current && !result.includes(canonical.resolvedPath)) {
		result.push(canonical.resolvedPath);
	}
	return result;
}

/**
 * For a path that does not exist (possibly a dangling symlink), climb to the
 * deepest existing ancestor, realpath it, and re-attach the missing tail —
 * so `./evil.txt -> ~/.ssh/authorized_keys2` still checks `~/.ssh`.
 */
function resolveDeepestExistingAncestor(missingPath: string): string | undefined {
	let parent = missingPath;
	const missingSegments: string[] = [];
	for (;;) {
		if (existsSync(parent)) break;
		const base = path.basename(parent);
		if (!base) break;
		missingSegments.unshift(base);
		const next = path.dirname(parent);
		if (next === parent) break;
		parent = next;
	}
	if (!existsSync(parent)) return undefined;
	let real = parent;
	try {
		real = realpathSync(parent);
	} catch {
		return undefined;
	}
	// The climb stopped at an existing ancestor of the missing leaf; if the
	// leaf itself is a dangling symlink, resolve its immediate target too.
	if (missingSegments.length === 0) return real;
	const viaLink = path.resolve(real, ...missingSegments);
	const finalSegment = missingSegments[missingSegments.length - 1];
	const linkParent = path.resolve(real, ...missingSegments.slice(0, -1));
	if (finalSegment && existsSync(linkParent)) {
		try {
			const stats = lstatSync(path.resolve(linkParent, finalSegment));
			if (stats.isSymbolicLink()) {
				const target = readlinkSync(path.resolve(linkParent, finalSegment));
				return path.isAbsolute(target) ? target : path.resolve(linkParent, target);
			}
		} catch {
			/* keep lexical answer */
		}
	}
	return viaLink;
}

// ============================================================================
// Suspicious patterns & dangerous paths
// ============================================================================

/** Windows UNC / WebDAV / IP-based network paths (Windows-relevant checks). */
export function containsVulnerableUncPath(p: string): boolean {
	const patterns: RegExp[] = [
		/\\\\[^\s\\/]+(?:@(?:\d+|ssl))?(?:[\\/]|$|\s)/i,
		/(?<!:)\/\/[^\s\\/]+(?:@(?:\d+|ssl))?(?:[\\/]|$|\s)/i,
		/\/\\{2,}[^\s\\/]/,
		/\\{2,}\/[^\s\\/]/,
		/@SSL@\d+/i,
		/@\d+@SSL/i,
		/DavWWWRoot/i,
		/^\\\\\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}[\\/]/,
		/^\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}[\\/]/,
		/^\\\\\[[\da-fA-F:]+\][\\/]/,
		/^\/\/\[[\da-fA-F:]+\][\\/]/,
	];
	// UNC semantics only threaten Windows hosts; the backslash patterns would
	// false-positive on POSIX paths containing escaped separators otherwise.
	if (process.platform !== "win32") return false;
	return patterns.some(re => re.test(p));
}

/** Windows-specific path patterns used to slip past literal string checks. */
export function hasSuspiciousWindowsPathPattern(p: string): boolean {
	if ((process.platform === "win32" || isWsl()) && p.indexOf(":", 2) !== -1) return true; // NTFS ADS
	if (/~\d/.test(p)) return true; // 8.3 short name
	if (p.startsWith("\\\\?\\")) return true;
	if (p.startsWith("\\\\.\\")) return true;
	if (p.startsWith("//?/")) return true;
	if (p.startsWith("//./")) return true;
	if (/[.\s]+$/.test(p)) return true; // trailing dot/space
	if (/\.(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(p)) return true; // DOS device
	if (/(^|\/|\\)\.{3,}(\/|\\|$)/.test(p)) return true; // 3+ consecutive dots segment
	return containsVulnerableUncPath(p);
}

function isWsl(): boolean {
	return typeof process.env.WSL_DISTRO_NAME === "string";
}

/** True when any segment is a dangerous directory or the file is dangerous. */
export function isDangerousFilePathToAutoEdit(inputPath: string): boolean {
	const absolutePath = expandPath(inputPath);
	if (inputPath.startsWith("\\\\") || inputPath.startsWith("//")) return true;
	const segments = absolutePath.split(path.sep);
	for (const segment of segments) {
		if (DANGEROUS_DIRECTORIES.some(dir => normalizeCaseForComparison(segment) === dir)) return true;
	}
	const fileName = segments[segments.length - 1] ?? "";
	return DANGEROUS_FILES.some(file => normalizeCaseForComparison(fileName) === file);
}

/**
 * True when the path is one of the agent's own configuration files — CC's
 * `isClaudeConfigFilePath` parity: always ask when the agent edits its own
 * config. Covers the agent-dir config layers (containment test, since
 * `PI_CODING_AGENT_DIR` can relocate the agent dir outside any dangerous
 * directory) and project settings files directly under `.omp/` or `.claude/`.
 * The write flow runs this over every symlink representation.
 */
export function isAgentConfigFilePath(inputPath: string, agentDir: string): boolean {
	const expanded = expandPath(inputPath);
	const segments = normalizeCaseForComparison(expanded).split(/[\\/]/);
	const fileName = segments[segments.length - 1] ?? "";
	if (!AGENT_CONFIG_FILENAMES.includes(fileName)) return false;
	// Direct child of a project config directory (CC's endsWith semantics).
	const parent = segments[segments.length - 2] ?? "";
	if (parent === ".omp" || parent === ".claude") return true;
	// The agent's own config directory, wherever it has been relocated.
	return pathInWorkingPath(expanded, agentDir);
}

export type PathSafetyResult = { safe: true } | { safe: false; message: string; classifierApprovable: boolean };

/**
 * Composite safety gate for writes: suspicious Windows patterns (never
 * classifier-approvable), then dangerous files/directories. Runs over the
 * literal and every symlink-resolved representation.
 */
export function checkPathSafetyForAutoEdit(inputPath: string, precomputed?: string[]): PathSafetyResult {
	const pathsToCheck = precomputed ?? getPathsForPermissionCheck(inputPath);
	for (const p of pathsToCheck) {
		if (hasSuspiciousWindowsPathPattern(p)) {
			return {
				safe: false,
				message: `Permission to write to ${inputPath}, which contains a suspicious Windows path pattern that requires manual approval.`,
				classifierApprovable: false,
			};
		}
	}
	for (const p of pathsToCheck) {
		if (isDangerousFilePathToAutoEdit(p)) {
			return {
				safe: false,
				message: `Permission to edit ${inputPath} which is a sensitive file.`,
				classifierApprovable: true,
			};
		}
	}
	return { safe: true };
}

// ============================================================================
// Working-directory containment
// ============================================================================

const resolvedWorkingDirCache = new Map<string, string[]>();

function resolvedWorkingDirs(workingDirectories: Iterable<string>): string[] {
	const out: string[] = [];
	for (const dir of workingDirectories) {
		let resolved = resolvedWorkingDirCache.get(dir);
		if (!resolved) {
			resolved = getPathsForPermissionCheck(dir);
			resolvedWorkingDirCache.set(dir, resolved);
		}
		out.push(...resolved);
	}
	return out;
}

/** Normalized containment test: is `p` at or under `workingPath`? */
export function pathInWorkingPath(p: string, workingPath: string): boolean {
	const expandedP = expandPath(p);
	const expandedW = expandPath(workingPath);
	const normalizedP = normalizeMacPrivate(expandedP);
	const normalizedW = normalizeMacPrivate(expandedW);
	const pLower = normalizeCaseForComparison(normalizedP);
	const wLower = normalizeCaseForComparison(normalizedW);
	const rel = relativePath(wLower, pLower);
	if (rel === "") return true;
	if (containsPathTraversal(rel)) return false;
	return !posix.isAbsolute(rel);
}

function normalizeMacPrivate(p: string): string {
	return p.replace(/^\/private\/var\//, "/var/").replace(/^\/private\/tmp(\/|$)/, "/tmp$1");
}

/**
 * True when EVERY representation of `p` (literal + symlink chain) lands inside
 * one of the working directories — inputs and directories resolve symmetrically.
 */
export function pathInAllowedWorkingPath(
	inputPath: string,
	workingDirectories: Iterable<string>,
	precomputed?: string[],
): boolean {
	const pathsToCheck = precomputed ?? getPathsForPermissionCheck(inputPath);
	const workingPaths = resolvedWorkingDirs(workingDirectories);
	return pathsToCheck.every(p => workingPaths.some(wp => pathInWorkingPath(p, wp)));
}

// ============================================================================
// Gitignore-style content rules: Edit(<pattern>) / Read(<pattern>)
// ============================================================================

type CompiledPattern = { root: string | null; regex: RegExp; dirPrefix: string | null };

/**
 * Split a rule pattern into (root, relative matcher). Roots: `//x` → fs root,
 * `~/x` → home, `/x` → cwd-relative, bare → matches at any depth. A trailing
 * `/**` turns the pattern into a directory-prefix rule.
 */
function compileRulePattern(pattern: string, cwd: string): CompiledPattern {
	let root: string | null = cwd;
	let body = pattern;
	if (pattern.startsWith("//")) {
		root = "/";
		body = pattern.slice(2);
	} else if (pattern.startsWith("~/")) {
		root = os.homedir().normalize("NFC");
		body = pattern.slice(2);
	} else if (pattern.startsWith("/")) {
		root = cwd;
		body = pattern.slice(1);
	} else {
		root = null;
		body = pattern.startsWith("./") ? pattern.slice(2) : pattern;
	}

	// A trailing `/**` turns the pattern into a directory-prefix rule (ignore
	// semantics: the directory itself and everything below it match).
	const dirPrefix: string | null = body.endsWith("/**") ? body.slice(0, -3) : null;
	const coreBody = dirPrefix !== null ? dirPrefix : body;
	// Patterns are lowered to mirror normalizeCaseForComparison's
	// case-insensitive matching semantics.
	return { root, regex: new RegExp(`^${compileGlobBody(coreBody.toLowerCase())}$`), dirPrefix };
}

/** Translate a gitignore-flavored pattern body into a regex source string. */
function compileGlobBody(pattern: string): string {
	let out = "";
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i];
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				if (pattern[i + 2] === "/") {
					out += "(?:.*/)?";
					i += 3;
					continue;
				}
				out += ".*";
				i += 2;
				continue;
			}
			out += "[^/]*";
			i += 1;
			continue;
		}
		if (ch === "?") {
			out += "[^/]";
			i += 1;
			continue;
		}
		out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/-/g, "\\-");
		i += 1;
	}
	// Slashless patterns match at any depth (gitignore basename semantics).
	if (!pattern.includes("/")) {
		out = `(?:.*/)?${out}`;
	}
	return out;
}

/**
 * Find the first rule whose content pattern matches `inputPath`.
 * `toolNames` selects the rule bucket (e.g. ["edit","write"] for writers) so
 * host tool renames keep binding the same rule content.
 */
export function matchingPathRuleForInput(
	inputPath: string,
	rules: ParsedRules,
	behavior: "allow" | "deny" | "ask",
	toolNames: readonly string[],
	cwd: string = process.cwd(),
): PermissionRule | null {
	const absolutePath = expandPath(inputPath, cwd);
	const bucket = rules[behavior].filter(rule => {
		return toolNames.includes(rule.ruleValue.toolName) && rule.ruleValue.ruleContent !== undefined;
	});
	for (const rule of bucket) {
		const pattern = rule.ruleValue.ruleContent as string;
		const compiled = compileRulePattern(pattern, cwd);
		const root = compiled.root ?? cwd;
		const rel = relativePath(root, absolutePath);
		if (rel.startsWith("..") || posix.isAbsolute(rel)) continue;
		if (rel === "") continue;
		if (compiled.dirPrefix !== null) {
			if (compiled.dirPrefix === "") return rule; // `<root>/**` covers the whole root
			const baseDir = path.join(root, compiled.dirPrefix.replace(/^\//, ""));
			const relBase = normalizeCaseForComparison(relativePath(root, baseDir));
			const relLower = normalizeCaseForComparison(rel);
			if (relLower === relBase || relLower.startsWith(`${relBase}/`)) return rule;
			continue;
		}
		if (compiled.regex.test(normalizeCaseForComparison(rel))) return rule;
	}
	return null;
}

// ============================================================================
// Dangerous removal targets (rm-style tools)
// ============================================================================

/** True for `/`, drive roots, home, and their direct children. */
export function isDangerousRemovalPath(resolvedPath: string): boolean {
	const forwardSlashed = resolvedPath.replace(/[\\/]+/g, "/");
	if (forwardSlashed === "*" || forwardSlashed.endsWith("/*")) return true;
	const normalizedPath = forwardSlashed === "/" ? "/" : forwardSlashed.replace(/\/$/, "");
	if (normalizedPath === "/") return true;
	if (WINDOWS_DRIVE_ROOT_REGEX.test(normalizedPath)) return true;
	const normalizedHome = os.homedir().replace(/[\\/]+/g, "/");
	if (normalizedPath === normalizedHome) return true;
	if (posix.dirname(normalizedPath) === "/") return true;
	if (WINDOWS_DRIVE_CHILD_REGEX.test(normalizedPath)) return true;
	return false;
}

// ============================================================================
// Suggestions
// ============================================================================

export type PathSuggestion =
	| { type: "setMode"; mode: "acceptEdits"; destination: "session" }
	| { type: "addDirectories"; directories: string[]; destination: "session" }
	| {
			type: "addRules";
			rules: { toolName: string; ruleContent: string }[];
			behavior: "allow";
			destination: "session";
	  };

/** "Grant access" fast options for the prompt: mode bump + directory reads. */
export function generatePathSuggestions(
	inputPath: string,
	operationType: "read" | "write",
	options: { mode: string; workingDirectories: Iterable<string> },
	precomputed?: string[],
): PathSuggestion[] {
	const outside = !pathInAllowedWorkingPath(inputPath, options.workingDirectories, precomputed);
	const shouldSuggestAcceptEdits = options.mode === "default" || options.mode === "plan";
	if (operationType === "write") {
		const updates: PathSuggestion[] = shouldSuggestAcceptEdits
			? [{ type: "setMode", mode: "acceptEdits", destination: "session" }]
			: [];
		if (outside) {
			updates.push({
				type: "addDirectories",
				directories: getPathsForPermissionCheck(directoryOf(inputPath)),
				destination: "session",
			});
		}
		return updates;
	}
	if (outside) {
		const dirs = getPathsForPermissionCheck(directoryOf(inputPath));
		return dirs
			.filter(dir => dir !== "/")
			.map(dir => ({
				type: "addRules" as const,
				rules: [{ toolName: "read", ruleContent: toPosix(dir) === "" ? "/**" : `${toPosix(dir)}/**` }],
				behavior: "allow" as const,
				destination: "session" as const,
			}));
	}
	return shouldSuggestAcceptEdits ? [{ type: "setMode", mode: "acceptEdits", destination: "session" }] : [];
}

function directoryOf(inputPath: string): string {
	const expanded = expandPath(inputPath);
	try {
		return statSync(expanded).isDirectory() ? expanded : path.dirname(expanded);
	} catch {
		return path.dirname(expanded);
	}
}
