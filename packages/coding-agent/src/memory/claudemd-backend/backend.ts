/**
 * `claudemd` memory backend — a port of Claude Code's file-based memory
 * system (memdir + turn-end extraction + dream consolidation) as an omp
 * `MemoryBackend`. See /tmp/cc-port-specs/memory.md; the per-module headers
 * list the verbatim-ported pieces and their deviations.
 *
 * Deviations from CC at the backend level:
 * - Directory layout: `${agentDir}/memory/` (single directory, no git-root
 *   keying, no team/KAIROS/remote layout, no env or settings path overrides).
 * - No forked-agent machinery: extraction and consolidation are single
 *   injected LLM calls through the `complete` seam. The default seam lazily
 *   wraps pi-ai `completeSimple` (the native-addon-dependent module graph is
 *   only entered when a real LLM call is made, never at import time) with the
 *   active session's model, reasoning disabled — omp's cheap/fast utility
 *   pattern.
 * - Recall delivery uses the omp `beforeAgentStartPrompt` staging contract
 *   (context appended to the winning base system prompt; `commit()` marks
 *   paths surfaced and charges the per-session byte budget) instead of CC's
 *   prefetched user-message attachments.
 * - The turn-end cursor is a message-count watermark (CC keys on message
 *   UUIDs); if the transcript shrinks (compaction), the watermark resets to
 *   zero so extraction is never permanently disabled — the same fallback CC
 *   applies when the cursor UUID disappears.
 * - Extraction mutual exclusion via hasMemoryWritesSince is not ported; see
 *   extraction.ts for the rationale.
 * - `save()` writes a topic file + index line directly with no LLM (powers
 *   /remember); a `Type: user`-style prefix in the content selects the type.
 */

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { warn as logWarn } from "@oh-my-pi/pi-utils/logger";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSession } from "../../session/agent-session";
import type {
	MemoryBackend,
	MemoryBackendOperationContext,
	MemoryBackendSaveInput,
	MemoryBackendSaveResult,
	MemoryBackendStartOptions,
	MemoryBackendStatus,
	MemoryPromptPreparation,
} from "../../memory-backend/types";
import {
	buildClaudeMdDeveloperInstructions,
	claudemdEntrypointPath,
	claudemdMemoryDir,
	parseMemoryType,
} from "./prompts";
import { formatMemoryManifest, scanMemorySources } from "./scan";
import { listMemorySources, resolveWriteTarget, type ClaudeSharedMode, type MemorySource } from "./paths";
import { mergeEntrypoints } from "./index-merge";
import { cfgMemoryClaudeShared } from "../../memory-backend/settings";
import { redactMemorySecrets } from "../../memory-backend/redact";
import type { Settings } from "../../config/settings";
import {
	applyDream,
	buildConsolidationPrompt,
	collectDreamContext,
	countSessionsTouchedSince,
	DREAM_MIN_HOURS,
	DREAM_MIN_SESSIONS,
	parseDreamResult,
	readLastConsolidatedAt,
	recordConsolidation,
	rollbackConsolidationLock,
	tryAcquireConsolidationLock,
} from "./dream";
import {
	applyExtraction,
	buildExtractionPrompt,
	buildExtractionUserPrompt,
	parseExtractionResult,
	serializeRecentMessages,
} from "./extraction";
import {
	collectRecentSuccessfulTools,
	findRelevantMemories,
	formatMemoryInjection,
	formatSelectorUserPrompt,
	MAX_SESSION_BYTES,
	readMemoriesForSurfacing,
	SELECT_MEMORIES_SYSTEM_PROMPT,
	type SelectMemoriesFn,
} from "./recall";

// ============================================================================
// LLM seam
// ============================================================================

/** One-shot LLM seam; tests fake it, the default lazily wraps pi-ai. */
export type ClaudeMdComplete = (system: string, user: string) => Promise<string>;

export interface ClaudeMdBackendOptions {
	/** Override the default pi-ai-backed completion (tests fake this). */
	complete?: ClaudeMdComplete;
}

/**
 * Per-session state, stored symbol-keyed on the AgentSession (mirrors the
 * sharpshooter backend's resource pattern).
 */
interface ClaudeMdSessionState {
	unsubscribe: () => void;
	session: AgentSession;
	agentDir: string;
	/** Claude-directory interop mode captured from settings at start(). */
	shared: ClaudeSharedMode;
	/** Paths injected into context this session (dedupe + budget). */
	surfacedPaths: Set<string>;
	/** Cumulative UTF-16 units injected this session (60 KiB budget). */
	surfacedBytes: number;
	/** Message-count watermark: extraction covers messages.length - cursor. */
	cursor: number;
	/** Mutual exclusion for the fire-and-forget extraction run. */
	extracting: boolean;
	/** A turn ended while extracting → trailing run after the current one. */
	pendingTurnEnd: boolean;
}

const kClaudeMdSessionState = Symbol("claudemd.sessionState");

interface ClaudeMdAgentSession extends AgentSession {
	[kClaudeMdSessionState]?: ClaudeMdSessionState;
}

function getSessionState(session: AgentSession): ClaudeMdSessionState | undefined {
	return (session as ClaudeMdAgentSession)[kClaudeMdSessionState];
}

/** Release session-owned subscriptions (mirrors sharpshooter's release fn). */
export function releaseClaudeMdSession(session: AgentSession): void {
	const ownedSession = session as ClaudeMdAgentSession;
	const state = ownedSession[kClaudeMdSessionState];
	if (!state) return;
	delete ownedSession[kClaudeMdSessionState];
	state.unsubscribe();
}

// ============================================================================
// save() helpers (powers /remember)
// ============================================================================

function slugify(text: string): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 40);
	return slug || "memory";
}

/** Render frontmatter + content for a saved topic file. */
function renderMemoryFile(params: { name: string; description: string; type: string; content: string }): string {
	return [
		"---",
		`name: ${params.name}`,
		`description: ${params.description}`,
		`type: ${params.type}`,
		"---",
		"",
		params.content,
		"",
	].join("\n");
}

async function readEntrypoint(memoryDir: string): Promise<string> {
	try {
		return await readFile(claudemdEntrypointPath(memoryDir), "utf8");
	} catch {
		return "";
	}
}

/**
 * Interop mode from the session's settings. `auto` on any failure: settings
 * may be a partial fake (tests) or not yet initialized, and the backend must
 * never break the agent loop over a memory preference read.
 */
function sharedMode(settings: Settings | undefined): ClaudeSharedMode {
	if (!settings) return "auto";
	try {
		return cfgMemoryClaudeShared.get(settings);
	} catch {
		return "auto";
	}
}

/**
 * Resolve active sources for a session: omp dir plus Claude directories when
 * interop applies. Re-resolved per use (cheap stat probes) so a mid-session
 * cwd change or a first CC write in another tool is picked up.
 */
async function resolveSources(state: ClaudeMdSessionState): Promise<MemorySource[]> {
	return listMemorySources({
		agentDir: state.agentDir,
		projectDir: state.session.sessionManager.getCwd(),
		shared: state.shared,
	});
}

/** Read every source's MEMORY.md and merge (CC sections lead, omp trails). */
async function readMergedEntrypoint(sources: readonly MemorySource[]): Promise<string> {
	const parts = await Promise.all(sources.map(async s => ({ kind: s.kind, content: await readEntrypoint(s.dir) })));
	return mergeEntrypoints(parts);
}

// ============================================================================
// Factory
// ============================================================================

export function createClaudeMdBackend(options?: ClaudeMdBackendOptions): MemoryBackend {
	const complete: ClaudeMdComplete = options?.complete ?? createDefaultComplete();
	/** Session captured at start(); the default seam's model source. */
	let activeSession: AgentSession | undefined;

	/**
	 * Default completion: the session's current model with reasoning disabled.
	 * pi-ai is imported lazily — its module graph pulls the native addon,
	 * which a memory backend's import must never depend on.
	 */
	function createDefaultComplete(): ClaudeMdComplete {
		let llm: typeof import("@oh-my-pi/pi-ai") | undefined;
		return async (system, user) => {
			const session = activeSession;
			if (!session) throw new Error("claudemd: no active session for default LLM call");
			const model = session.model;
			if (!model) throw new Error("claudemd: no model selected");
			if (llm === undefined) llm = await import("@oh-my-pi/pi-ai");
			const apiKey = await session.modelRegistry.getApiKey(model, session.sessionId);
			const message = await llm.completeSimple(
				model,
				{
					systemPrompt: [system],
					messages: [{ role: "user", content: user, timestamp: Date.now() }],
				},
				{
					apiKey: apiKey ?? undefined,
					maxTokens: 4096,
					disableReasoning: true,
				},
			);
			if (message.stopReason === "error") throw new Error(message.errorMessage ?? "Provider error");
			const text = message.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");
			if (!text.trim()) throw new Error("claudemd: empty model response");
			return text;
		};
	}

	async function runExtraction(state: ClaudeMdSessionState): Promise<void> {
		const { session } = state;
		const sources = await resolveSources(state);
		const writeDir = resolveWriteTarget(sources);
		const messages: readonly AgentMessage[] = session.messages;
		// Watermark: if the transcript shrank (compaction removed the cursor
		// range), fall back to counting ALL messages so extraction never
		// permanently disables — same fallback CC has for a missing UUID.
		const cursor = state.cursor > messages.length ? 0 : state.cursor;
		const newMessages = messages.slice(cursor);
		const { text: transcript, count: newMessageCount } = serializeRecentMessages(newMessages);
		if (!transcript) {
			state.cursor = messages.length;
			return;
		}

		const [memories, entrypointContent] = await Promise.all([
			scanMemorySources(sources),
			readMergedEntrypoint(sources),
		]);

		const prompt = buildExtractionPrompt({
			newMessageCount,
			existingMemories: formatMemoryManifest(memories),
			currentIndex: entrypointContent,
		});
		const response = await complete(prompt, buildExtractionUserPrompt(prompt, transcript));
		const result = parseExtractionResult(response);
		// Unparseable output → cursor NOT advanced, so the same messages are
		// reconsidered next turn (CC advances only after a successful run).
		if (!result) return;
		state.cursor = messages.length;
		if (result.files.length === 0 && result.indexLines.length === 0) return;
		const applied = await applyExtraction(writeDir, result);
		if (applied.written.length > 0) {
			logWarn("Claudemd: extraction saved memories.", { files: applied.written.join(", ") });
		}
	}

	/** Fire-and-forget extraction with stash + trailing-run semantics (CC §5). */
	function maybeRunExtraction(state: ClaudeMdSessionState): void {
		if (state.extracting) {
			// Overwrite any prior stash — only the latest trailing run survives.
			state.pendingTurnEnd = true;
			return;
		}
		state.extracting = true;
		void runExtraction(state)
			.catch(error => {
				logWarn("Claudemd: extraction failed; skipping this turn.", { error: String(error) });
			})
			.finally(() => {
				state.extracting = false;
				if (state.pendingTurnEnd) {
					state.pendingTurnEnd = false;
					maybeRunExtraction(state);
				}
			});
	}

	/**
	 * Shared consolidation run: lock → LLM → apply → stamp; rollback on
	 * failure so the time gate reopens (CC semantics).
	 */
	async function runDream(memoryDir: string): Promise<{ summary: string; written: number; removed: number }> {
		const priorMtime = await tryAcquireConsolidationLock(memoryDir);
		if (priorMtime === null) throw new Error("claudemd: consolidation lock is held by another run");
		try {
			const context = await collectDreamContext(memoryDir);
			const prompt = buildConsolidationPrompt(memoryDir, context);
			const response = await complete(prompt, "Perform the dream now, following the output format above.");
			const result = parseDreamResult(response);
			if (!result) throw new Error("claudemd: unparseable dream output");
			const applied = await applyDream(memoryDir, result);
			// Success: the lock mtime left at "now" is the completion record.
			await recordConsolidation(memoryDir);
			const parts = [
				applied.written.length > 0 ? `${applied.written.length} files written` : "no files written",
				applied.removed.length > 0 ? `${applied.removed.length} removed` : null,
				applied.indexAppended > 0 ? `${applied.indexAppended} index lines added` : null,
				applied.indexPointerRemoved > 0 ? `${applied.indexPointerRemoved} index pointers dropped` : null,
			].filter(Boolean);
			return {
				summary: result.summary || parts.join(", "),
				written: applied.written.length,
				removed: applied.removed.length,
			};
		} catch (error) {
			await rollbackConsolidationLock(memoryDir, priorMtime);
			throw error;
		}
	}

	/** Auto-dream: cheapest-first gates, then the shared run (CC gate order). */
	async function maybeAutoDream(state: ClaudeMdSessionState): Promise<void> {
		const { session } = state;
		const writeDir = resolveWriteTarget(await resolveSources(state));
		const lastAt = await readLastConsolidatedAt(writeDir);
		const hoursSince = (Date.now() - lastAt) / 3_600_000;
		if (hoursSince < DREAM_MIN_HOURS) return;
		const sessionCount = await countSessionsTouchedSince(session.settings.getAgentDir(), lastAt);
		if (sessionCount < DREAM_MIN_SESSIONS) return;
		await runDream(writeDir);
	}

	return {
		id: "claudemd",

		start(startOptions: MemoryBackendStartOptions): void {
			// Extraction/dream run on the main session only (CC's !agentId gate).
			if (startOptions.taskDepth > 0) return;
			const { session } = startOptions;
			try {
				releaseClaudeMdSession(session);
				const state: ClaudeMdSessionState = {
					unsubscribe: () => {},
					session,
					agentDir: startOptions.agentDir,
					shared: sharedMode(startOptions.settings),
					surfacedPaths: new Set(),
					surfacedBytes: 0,
					cursor: 0,
					extracting: false,
					pendingTurnEnd: false,
				};
				state.unsubscribe = session.subscribe(event => {
					if (event.type !== "turn_end") return;
					try {
						maybeRunExtraction(state);
					} catch (error) {
						logWarn("Claudemd: turn-end handler failed.", { error: String(error) });
					}
					void maybeAutoDream(state).catch(error => {
						logWarn("Claudemd: auto-dream failed.", { error: String(error) });
					});
				});
				(session as ClaudeMdAgentSession)[kClaudeMdSessionState] = state;
				activeSession = session;
			} catch (error) {
				logWarn("Claudemd: backend startup failed; memory backend inert.", { error: String(error) });
			}
		},

		async buildDeveloperInstructions(agentDir, settings, session): Promise<string | undefined> {
			try {
				const sources = await listMemorySources({
					agentDir,
					projectDir: session?.sessionManager.getCwd() ?? process.cwd(),
					shared: sharedMode(settings),
				});
				// Pre-create only the omp dir (harness contract); read paths must
				// never materialize Claude directories.
				await mkdir(claudemdMemoryDir(agentDir), { recursive: true });
				const writeDir = resolveWriteTarget(sources);
				const entrypointContent = await readMergedEntrypoint(sources);
				const readonlyDirs = sources.filter(s => !s.writable).map(s => s.dir);
				return buildClaudeMdDeveloperInstructions(writeDir, entrypointContent, readonlyDirs);
			} catch (error) {
				logWarn("Claudemd: failed to build developer instructions.", { error: String(error) });
				return undefined;
			}
		},

		async beforeAgentStartPrompt(session, promptText, signal): Promise<MemoryPromptPreparation | undefined> {
			const state = getSessionState(session);
			if (!state) return undefined;
			try {
				const query = promptText.trim();
				// Single-word prompts lack enough context for meaningful recall
				// (CC startRelevantMemoryPrefetch guard).
				if (!query || !/\s/.test(query)) return undefined;
				if (signal?.aborted) return undefined;
				// Per-session budget exhausted → stop recall entirely (CC guard).
				if (state.surfacedBytes >= MAX_SESSION_BYTES) return undefined;

				const recentTools = collectRecentSuccessfulTools(session.messages);
				const select: SelectMemoriesFn = (q, manifest, tools) =>
					complete(SELECT_MEMORIES_SYSTEM_PROMPT, formatSelectorUserPrompt(q, manifest, tools));
				const selected = await findRelevantMemories({
					query,
					sources: await resolveSources(state),
					select,
					signal,
					recentTools,
					alreadySurfaced: state.surfacedPaths,
				});
				if (selected.length === 0) return undefined;
				if (signal?.aborted) return undefined;

				const surfaced = await readMemoriesForSurfacing(selected, signal);
				if (surfaced.length === 0) return undefined;

				const context = formatMemoryInjection(surfaced);
				return {
					context,
					commit: () => {
						if (getSessionState(session) !== state) return false;
						for (const memory of surfaced) {
							state.surfacedPaths.add(memory.path);
							state.surfacedBytes += memory.byteCount;
						}
						return true;
					},
				};
			} catch (error) {
				if (!signal?.aborted) {
					logWarn("Claudemd: recall failed.", { error: String(error) });
				}
				return undefined;
			}
		},

		async clear(agentDir, cwd, session): Promise<void> {
			// Wipe only omp's own directory — Claude Code directories belong to
			// Claude Code and are never deleted from here, even when shared.
			const sources = await listMemorySources({
				agentDir,
				projectDir: cwd,
				shared: sharedMode(session?.settings),
			});
			for (const source of sources) {
				if (source.kind === "omp") await rm(source.dir, { recursive: true, force: true });
			}
		},

		async enqueue(agentDir, cwd, session): Promise<void> {
			const sources = await listMemorySources({
				agentDir,
				projectDir: cwd,
				shared: sharedMode(session?.settings),
			});
			await runDream(resolveWriteTarget(sources));
		},

		async save(
			context: MemoryBackendOperationContext,
			input: MemoryBackendSaveInput,
		): Promise<MemoryBackendSaveResult> {
			const sources = await listMemorySources({
				agentDir: context.agentDir,
				projectDir: context.cwd,
				shared: sharedMode(context.session?.settings),
			});
			const memoryDir = resolveWriteTarget(sources);
			// Redact before anything derived from the content is persisted —
			// recall injects these files into every later session, and with
			// claudeShared on the write target is shared with Claude Code.
			const content = redactMemorySecrets(input.content.trim());
			if (!content) {
				return { backend: "claudemd", stored: 0, message: "Nothing to save: content is empty." };
			}

			const firstLine =
				content
					.split("\n")
					.find(l => l.trim())
					?.trim() ?? "memory";
			// A type prefix in the content selects the type. Two accepted forms:
			// `user: text` (bare, separator required) and `Type: user text`
			// (documentation sugar, whitespace-separated); both strip the prefix.
			let name = firstLine;
			let explicitType: string | undefined;
			const typePrefix = /^(?:(user|feedback|project|reference)\s*[:-]\s+|type:\s*(user|feedback|project|reference)\s+)/i.exec(
				firstLine,
			);
			if (typePrefix) {
				explicitType = (typePrefix[1] ?? typePrefix[2])!.toLowerCase();
				name = firstLine.slice(typePrefix[0].length).trim() || firstLine;
			}
			const type = explicitType ?? parseMemoryType(input.source) ?? "project";
			const description = (input.context?.trim() || name).slice(0, 150);
			const slug = slugify(name);

			await mkdir(memoryDir, { recursive: true });
			let filename = `${slug}.md`;
			let attempt = 1;
			for (;;) {
				try {
					await stat(path.join(memoryDir, filename));
					attempt += 1;
					filename = `${slug}-${attempt}.md`;
				} catch {
					break;
				}
			}

			await writeFile(
				path.join(memoryDir, filename),
				renderMemoryFile({ name, description, type, content }),
				"utf8",
			);

			const title = name.length > 60 ? `${name.slice(0, 57)}...` : name;
			const indexLine = `- [${title}](${filename}) — ${description}`;
			const entrypointPath = claudemdEntrypointPath(memoryDir);
			const existing = await readEntrypoint(memoryDir);
			const prefix = existing.length > 0 && !existing.endsWith("\n") ? `${existing}\n` : existing;
			await writeFile(entrypointPath, prefix + indexLine + "\n", "utf8");

			return {
				backend: "claudemd",
				stored: 1,
				ids: [filename],
				message: `Saved memory to ${path.join(memoryDir, filename)} (${type}).`,
			};
		},

		async status(context: MemoryBackendOperationContext): Promise<MemoryBackendStatus> {
			const sources = await listMemorySources({
				agentDir: context.agentDir,
				projectDir: context.cwd,
				shared: sharedMode(context.session?.settings),
			});
			const writeDir = resolveWriteTarget(sources);
			const files = await scanMemorySources(sources);
			const lastConsolidatedAt = await readLastConsolidatedAt(writeDir);
			const extraSources = sources.filter(s => s.kind !== "omp").length;
			return {
				backend: "claudemd",
				active: true,
				writable: true,
				searchable: false,
				scope: writeDir,
				lastMemory: files[0]?.filename,
				message: `MEMORY.md + ${files.length} topic files${
					extraSources > 0 ? ` across ${sources.length} sources` : ""
				}; last consolidated: ${lastConsolidatedAt ? new Date(lastConsolidatedAt).toISOString() : "never"}`,
			};
		},
	};
}

/** Singleton backend using the default LLM seam. */
export const claudemdBackend: MemoryBackend = createClaudeMdBackend();
