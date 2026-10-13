/**
 * Project-level `.claude/` JSON write side — a direct port of Claude Code's
 * settings-write semantics. Sources of truth (all in `/root/xiaocongyu66-claude-code`):
 *
 * - `src/utils/settings/settings.ts:416-524` `updateSettingsForSource`:
 *   mkdir → read existing with a two-level corruption guard (JSON *syntax*
 *   error → return an error and never overwrite; parseable non-conforming
 *   data is kept as the merge base via `typeof rawData === "object"`) →
 *   mergeWith (arrays replace wholesale, explicit `undefined` deletes keys) →
 *   write `JSON.stringify(…, null, 2) + "\n"` → for `localSettings`,
 *   `void addFileGlobRuleToGitignore(relativePath, cwd)`.
 * - `src/utils/settings/settings.ts:298-307` `getRelativeSettingsFilePathForSource`:
 *   localSettings is `join(".claude", "settings.local.json")`.
 * - `src/utils/permissions/permissionsLoader.ts:229-297` `addPermissionRulesToSettings`:
 *   no rules → success without writing; dedup by normalizing BOTH sides via a
 *   parse→serialize roundtrip; appended rules are stored in serialized
 *   (normalized) form while existing raw rules are preserved untouched;
 *   nothing new to add → success without writing (and without gitignore);
 *   failures are caught and reported as a result, never thrown.
 * - `src/utils/permissions/permissionRuleParser.ts:47-160` rule string
 *   grammar: `"Tool"` / `"Tool(content)"` with `\\(`/`\\)` escaping; `"Tool()"`
 *   and `"Tool(*)"` normalize to the bare tool name. (The LEGACY_TOOL_NAME_
 *   ALIASES table is CC-internal and intentionally not ported.)
 * - `src/utils/git/gitignore.ts:53-110` `addFileGlobRuleToGitignore`: only
 *   acts inside a git repo; skips when `git check-ignore` says the path is
 *   already ignored; otherwise appends a doublestar rule (`**` + slash +
 *   path) to the *global* gitignore
 *   at `~/.config/git/ignore` — substring idempotence, a leading `"\n"` on
 *   append, creates the file when missing, swallows all errors.
 *
 * Deliberate port deviations (documented, semantic-preserving):
 * - the write is atomic (temp `wx` + fsync + rename) instead of CC's
 *   writeFileSyncAndFlush; the final bytes are identical, crash behavior is
 *   strictly better. CC's `markInternalWrite`/`resetSettingsCache` are
 *   omitted — omp has no settings watcher/cache here.
 * - `appendPermissionRule` awaits the gitignore update instead of CC's
 *   fire-and-forget `void` (same outcome, deterministic for callers/tests).
 * - a merge base that parses to a top-level *array* is folded into object
 *   form by the deep merge instead of lodash's array-with-extra-props quirk
 *   (which JSON.stringify would silently drop — CC loses the patch there).
 *
 * Scope reductions (deliberate, not ported by this batch):
 * - `projectSettings` writes (CC `updateSettingsForSource('projectSettings')`
 *   → `.claude/settings.json`, the team-committed file) — omp only ever writes
 *   the personal `localSettings` layer.
 * - rule removal (CC `removePermissionRules`) — omp has no UI/flow that
 *   deletes persisted rules yet.
 * - the CC `agents` wizard write side (CC `components/agents/agentFileUtils.ts`
 *   creating `.claude/agents/<name>.md`) — omp's `omp agents unpack --project`
 *   is the only omp writer there.
 *
 * Red line: this module must never import `../security/*` or `../session/*`;
 * rule-string handling here is the plain-text grammar above, not the
 * security rule engine.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { isEnoent } from "@oh-my-pi/pi-utils";

const execFileAsync = promisify(execFile);

/** Relative path (from the project root) of the personal local settings file. Port of settings.ts:298-307. */
export const LOCAL_SETTINGS_RELATIVE_PATH = ".claude/settings.local.json";

export type ClaudeWriteResult = { error?: Error };

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a Claude settings JSON file. Returns `null` when the file does not
 * exist, the JSON is corrupt, or the top-level value is not an object.
 */
export async function readClaudeSettingsFile(filePath: string): Promise<JsonObject | null> {
	let content: string;
	try {
		content = await fs.readFile(filePath, "utf8");
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return null;
	}
	return isPlainObject(parsed) ? parsed : null;
}

/**
 * Merge `source` into `target` with CC's `mergeWith` customizer semantics
 * (settings.ts:476-495): arrays are replaced wholesale (the caller computes
 * the desired final state), and a key present in `source` with an explicit
 * `undefined` value deletes the key from the merge result.
 */
function deepMerge(target: JsonObject, source: JsonObject): JsonObject {
	const merged: JsonObject = { ...target };
	for (const [key, sourceValue] of Object.entries(source)) {
		if (sourceValue === undefined) {
			delete merged[key];
			continue;
		}
		const targetValue = merged[key];
		if (Array.isArray(sourceValue)) {
			merged[key] = sourceValue;
			continue;
		}
		if (isPlainObject(sourceValue) && isPlainObject(targetValue)) {
			merged[key] = deepMerge(targetValue, sourceValue);
			continue;
		}
		merged[key] = sourceValue;
	}
	return merged;
}

/**
 * Atomic write: temp file opened with `wx`, fsynced, then renamed over the
 * target (temp name carries pid + random suffix so concurrent writers never
 * collide). The temp file is removed if the rename fails.
 */
async function writeAtomically(filePath: string, content: string): Promise<void> {
	const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	let removeTemp = false;
	try {
		const handle = await fs.open(tempPath, "wx", 0o600);
		removeTemp = true;
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fs.rename(tempPath, filePath);
		removeTemp = false;
	} finally {
		if (removeTemp) {
			await fs.rm(tempPath, { force: true }).catch(() => {});
		}
	}
}

/**
 * Merge `patch` into the settings JSON at `filePath`, CC's
 * `updateSettingsForSource` semantics (settings.ts:416-524):
 * 1. create the parent directory when missing,
 * 2. two-level corruption guard: a file whose JSON has a *syntax* error
 *    returns an error and is never overwritten; a file that parses to
 *    non-conforming data keeps that raw data as the merge base when it is
 *    `typeof "object"` (CC: `rawData && typeof rawData === "object"`),
 *    scalars fall back to an empty base,
 * 3. deep-merge (arrays replace, explicit `undefined` values delete keys),
 * 4. write two-space JSON with a trailing newline (atomically here).
 */
export async function writeClaudeSettingsJson(filePath: string, patch: JsonObject): Promise<ClaudeWriteResult> {
	try {
		await fs.mkdir(path.dirname(filePath), { recursive: true });

		// Corruption guard (CC settings.ts:444-472): a syntactically broken
		// file must surface an error, never be silently replaced.
		let existing: JsonObject = {};
		let content: string | null = null;
		try {
			content = await fs.readFile(filePath, "utf8");
		} catch (error) {
			if (!isEnoent(error)) {
				return { error: error instanceof Error ? error : new Error(String(error)) };
			}
		}
		if (content !== null) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(content);
			} catch {
				return { error: new Error(`Invalid JSON syntax in settings file at ${filePath}`) };
			}
			if (parsed !== null && typeof parsed === "object") {
				existing = parsed as JsonObject;
			}
		}

		const updated = deepMerge(existing, patch);
		await writeAtomically(filePath, `${JSON.stringify(updated, null, 2)}\n`);
		return {};
	} catch (error) {
		return { error: error instanceof Error ? error : new Error(String(error)) };
	}
}

/* --------------------------------------------------------------------------
 * Permission rule grammar — port of permissionRuleParser.ts:47-160.
 * ------------------------------------------------------------------------ */

type PermissionRuleValue = { toolName: string; ruleContent?: string };

/** Port of escapeRuleContent (permissionRuleParser.ts:47-57). */
function escapeRuleContent(content: string): string {
	return content
		.replace(/\\/g, "\\\\") // Escape backslashes first
		.replace(/\(/g, "\\(") // Then escape parentheses
		.replace(/\)/g, "\\)");
}

/** Port of unescapeRuleContent (permissionRuleParser.ts:70-76). */
function unescapeRuleContent(content: string): string {
	return content
		.replace(/\\\(/g, "(") // Unescape parentheses first
		.replace(/\\\)/g, ")")
		.replace(/\\\\/g, "\\"); // Then unescape backslashes
}

/** Port of findFirstUnescapedChar (permissionRuleParser.ts:167-185). */
function findFirstUnescapedChar(str: string, char: string): number {
	for (let i = 0; i < str.length; i++) {
		if (str[i] === char) {
			let backslashCount = 0;
			let j = i - 1;
			while (j >= 0 && str[j] === "\\") {
				backslashCount++;
				j--;
			}
			if (backslashCount % 2 === 0) return i;
		}
	}
	return -1;
}

/** Port of findLastUnescapedChar (permissionRuleParser.ts:187-205). */
function findLastUnescapedChar(str: string, char: string): number {
	for (let i = str.length - 1; i >= 0; i--) {
		if (str[i] === char) {
			let backslashCount = 0;
			let j = i - 1;
			while (j >= 0 && str[j] === "\\") {
				backslashCount++;
				j--;
			}
			if (backslashCount % 2 === 0) return i;
		}
	}
	return -1;
}

/**
 * Port of permissionRuleValueFromString (permissionRuleParser.ts:93-133).
 * Format: `"ToolName"` or `"ToolName(content)"`, content may contain escaped
 * parentheses. `"Tool()"` and `"Tool(*)"` collapse to the bare tool name
 * (tool-wide rule); malformed strings are treated as plain tool names. The
 * LEGACY_TOOL_NAME_ALIASES lookup of the original is intentionally omitted.
 */
function permissionRuleValueFromString(ruleString: string): PermissionRuleValue {
	const openParenIndex = findFirstUnescapedChar(ruleString, "(");
	if (openParenIndex === -1) {
		return { toolName: ruleString };
	}
	const closeParenIndex = findLastUnescapedChar(ruleString, ")");
	if (closeParenIndex === -1 || closeParenIndex <= openParenIndex) {
		return { toolName: ruleString };
	}
	if (closeParenIndex !== ruleString.length - 1) {
		return { toolName: ruleString };
	}
	const toolName = ruleString.substring(0, openParenIndex);
	const rawContent = ruleString.substring(openParenIndex + 1, closeParenIndex);
	if (!toolName) {
		return { toolName: ruleString };
	}
	if (rawContent === "" || rawContent === "*") {
		return { toolName };
	}
	return { toolName, ruleContent: unescapeRuleContent(rawContent) };
}

/** Port of permissionRuleValueToString (permissionRuleParser.ts:144-155). */
function permissionRuleValueToString(ruleValue: PermissionRuleValue): string {
	if (!ruleValue.ruleContent) {
		return ruleValue.toolName;
	}
	return `${ruleValue.toolName}(${escapeRuleContent(ruleValue.ruleContent)})`;
}

/**
 * CC's dedup normalization (permissionsLoader.ts:267-270): a parse→serialize
 * roundtrip so `"Bash(*)"` ≡ `"Bash"` and legacy spellings collapse before
 * comparison. Pure text — no dependency on the security rule parser.
 */
function normalizeRuleForDedup(rule: string): string {
	return permissionRuleValueToString(permissionRuleValueFromString(rule));
}

/* --------------------------------------------------------------------------
 * Gitignore maintenance — port of git/gitignore.ts:53-110.
 * ------------------------------------------------------------------------ */

/** Runs `git` with the given args in `cwd`; returns the exit code, 128 on failure. */
async function gitExitCode(args: string[], cwd: string): Promise<number> {
	try {
		// Promisified execFile resolves only on exit code 0; nonzero exits reject
		// with the code attached to the error (handled below).
		await execFileAsync("git", args, { cwd });
		return 0;
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		return typeof code === "number" ? code : 128;
	}
}

/**
 * Port of dirIsInGitRepo (git.ts:253-255 via findGitRoot): walk up from
 * `startPath` looking for a `.git` entry (directory or worktree gitfile).
 */
async function dirIsInGitRepo(startPath: string): Promise<boolean> {
	let current = path.resolve(startPath);
	for (;;) {
		try {
			await fs.stat(path.join(current, ".git"));
			return true;
		} catch {
			/* keep walking up */
		}
		const parent = path.dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

/**
 * Port of isPathGitignored (gitignore.ts:24-41): `git check-ignore` exit
 * code 0 means ignored; anything else (including "not a repo" 128 and spawn
 * failures) fails open to false.
 */
async function isPathGitignored(filePath: string, cwd: string): Promise<boolean> {
	return (await gitExitCode(["check-ignore", filePath], cwd)) === 0;
}

/**
 * Port of addFileGlobRuleToGitignore (gitignore.ts:53-110). Ensures
 * `<filename>` (relative to `projectDir`) is covered by the *global*
 * gitignore (`~/.config/git/ignore`) as a doublestar rule (`**` + slash +
 * filename) — CC's actual
 * destination, deliberately not the project `.gitignore`:
 * - no-ops outside a git repo,
 * - no-ops when the path is already ignored by any gitignore source,
 * - substring idempotence against the global file, appends `"\n" + rule`,
 * - creates the global file when missing,
 * - swallows every error (CC: `logError` only) — never throws.
 */
export async function ensureGitignoreEntry(
	projectDir: string,
	filename: string = LOCAL_SETTINGS_RELATIVE_PATH,
): Promise<void> {
	try {
		if (!(await dirIsInGitRepo(projectDir))) {
			return;
		}
		const gitignoreEntry = `**/${filename}`;
		const testPath = filename.endsWith("/") ? `${filename}sample-file.txt` : filename;
		if (await isPathGitignored(testPath, projectDir)) {
			return;
		}
		// homedir() is read at call time (as in CC) so tests can redirect HOME.
		const globalGitignorePath = path.join(os.homedir(), ".config", "git", "ignore");
		await fs.mkdir(path.dirname(globalGitignorePath), { recursive: true });
		try {
			const content = await fs.readFile(globalGitignorePath, "utf-8");
			if (content.includes(gitignoreEntry)) {
				return;
			}
			await fs.appendFile(globalGitignorePath, `\n${gitignoreEntry}\n`);
		} catch (error) {
			if (isEnoent(error)) {
				await fs.writeFile(globalGitignorePath, `${gitignoreEntry}\n`, "utf-8");
			} else {
				throw error;
			}
		}
	} catch {
		// CC only logs gitignore failures; they must never break a rule write.
	}
}

/**
 * Append permission rules to `permissions.<behavior>` in
 * `<projectDir>/.claude/settings.local.json`. Port of
 * addPermissionRulesToSettings (permissionsLoader.ts:229-297) composed with
 * writeClaudeSettingsJson:
 * - nothing to add (empty input, or every rule already present under the
 *   parse→serialize dedup) → success without touching any file,
 * - existing raw rules are preserved verbatim; appended rules are stored in
 *   normalized form (CC stores `permissionRuleValueToString` output),
 * - like CC, duplicate rules *within one call's input* are not collapsed —
 *   only duplicates against the on-disk group are filtered,
 * - a corrupt settings file yields `{ error }` and is never overwritten,
 * - failures never throw: they surface via `{ error }` (CC logs and returns
 *   `false`; omp reports the error to the UI).
 * On a successful write the global-gitignore maintenance runs (CC's
 * `localSettings` branch inside `updateSettingsForSource`, awaited here).
 */
export async function appendPermissionRule(
	projectDir: string,
	behavior: "allow" | "deny" | "ask",
	rules: string[],
): Promise<ClaudeWriteResult> {
	try {
		if (rules.length < 1) return {};
		const settingsPath = path.join(projectDir, LOCAL_SETTINGS_RELATIVE_PATH);
		const settingsData = (await readClaudeSettingsFile(settingsPath)) ?? {};
		const existingPermissions = isPlainObject(settingsData.permissions) ? settingsData.permissions : {};
		const existingRules = Array.isArray(existingPermissions[behavior])
			? existingPermissions[behavior].filter((rule): rule is string => typeof rule === "string")
			: [];
		const existingRulesSet = new Set(existingRules.map(normalizeRuleForDedup));
		const newRules = rules.map(normalizeRuleForDedup).filter(rule => !existingRulesSet.has(rule));
		if (newRules.length === 0) {
			return {};
		}
		const result = await writeClaudeSettingsJson(settingsPath, {
			permissions: { ...existingPermissions, [behavior]: [...existingRules, ...newRules] },
		});
		if (result.error) return result;
		await ensureGitignoreEntry(projectDir, LOCAL_SETTINGS_RELATIVE_PATH);
		return {};
	} catch (error) {
		return { error: error instanceof Error ? error : new Error(String(error)) };
	}
}
