/**
 * Subdirectory context-file hints (Claude Code parity for lazy
 * CLAUDE.md/AGENTS.md loading): startup only loads context files from cwd and
 * its ancestors, so when a tool first touches a file in a deeper directory
 * that carries its own CLAUDE.md (preferred) or AGENTS.md, we append a
 * one-line pointer to the tool result and let the model decide to read it.
 *
 * Per-session dedupe keeps a positive cache (hinted directories) and a
 * negative cache (probed directories without a context file), both capped.
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";

const POSITIVE_CACHE_CAP = 64;
const NEGATIVE_CACHE_CAP = 256;

interface SubdirHintTracker {
	positive: Set<string>;
	negative: Set<string>;
}

const kSubdirHintTracker = Symbol.for("omp.subdirContextHint.tracker");

type SessionWithSubdirTracker = { [kSubdirHintTracker]?: SubdirHintTracker };

function trackerFor(session: object): SubdirHintTracker {
	const holder = session as SessionWithSubdirTracker;
	holder[kSubdirHintTracker] ??= { positive: new Set(), negative: new Set() };
	return holder[kSubdirHintTracker]!;
}

/**
 * True when `dir` is strictly below `cwd` and no path segment between them
 * starts with a dot (hidden directories like `.claude/` or `.worktrees/` are
 * excluded from discovery, matching the startup walker).
 */
function isHintableSubdirectory(cwd: string, dir: string): boolean {
	const relative = path.relative(cwd, dir);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
	return relative.split(path.sep).every(segment => !segment.startsWith("."));
}

async function findContextFile(dir: string): Promise<string | undefined> {
	for (const name of ["CLAUDE.md", "AGENTS.md"]) {
		const candidate = path.join(dir, name);
		try {
			await fsp.access(candidate);
			return candidate;
		} catch {
			// keep probing
		}
	}
	return undefined;
}

/**
 * Return the one-line hint for the directory containing `filePath`, or
 * undefined when there is nothing to say (already hinted, negative-cached,
 * outside the workspace, or no context file present).
 *
 * `afterWrite` invalidates the negative cache for the touched directory:
 * a context file may have been created mid-session (git checkout, user),
 * and write tools are exactly the moment that becomes visible.
 */
export async function subdirContextHint(
	session: object,
	cwd: string,
	filePath: string,
	opts: { afterWrite?: boolean } = {},
): Promise<string | undefined> {
	const dir = path.dirname(path.resolve(cwd, filePath));
	const tracker = trackerFor(session);
	if (tracker.positive.has(dir)) return undefined;
	if (opts.afterWrite) tracker.negative.delete(dir);
	if (tracker.negative.has(dir)) return undefined;

	if (!isHintableSubdirectory(cwd, dir)) {
		tracker.negative.add(dir);
		if (tracker.negative.size > NEGATIVE_CACHE_CAP) tracker.negative.clear();
		return undefined;
	}

	const contextFile = await findContextFile(dir);
	if (!contextFile) {
		tracker.negative.add(dir);
		if (tracker.negative.size > NEGATIVE_CACHE_CAP) tracker.negative.clear();
		return undefined;
	}

	tracker.positive.add(dir);
	if (tracker.positive.size > POSITIVE_CACHE_CAP) tracker.positive.clear();
	return `This file's directory has its own instructions file: ${contextFile}. Read it before making further changes in this directory if you have not already.`;
}

/** Append the subdir hint to a successful local-file tool result, if any. */
export async function appendSubdirContextHint(
	session: object,
	cwd: string,
	filePath: string,
	result: { isError?: boolean; content?: Array<{ type: string; text?: string }> },
	opts: { afterWrite?: boolean } = {},
): Promise<void> {
	if (result.isError) return;
	const block = result.content?.find(entry => entry.type === "text");
	if (!block || typeof block.text !== "string") return;
	const hint = await subdirContextHint(session, cwd, filePath, opts);
	if (!hint) return;
	block.text += `\n\n[${hint}]`;
}
