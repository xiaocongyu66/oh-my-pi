/**
 * Memory-authoring slash commands for the `claudemd` backend: `/remember`
 * (direct save, no LLM) and `/dream` (manual consolidation). Mirrors the
 * `/memory` command patterns in `builtin-lifecycle.ts`; unlike `/memory`,
 * these route through `resolveMemoryBackend` so they work with any backend
 * that implements `save`/`enqueue`.
 */

import { resolveMemoryBackend } from "../memory-backend";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime, SlashCommandSpec } from "./types";

async function handleRemember(_command: ParsedSlashCommand, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const content = _command.args.trim();
	if (!content) {
		return usage(
			"Usage: /remember <text> — saves a memory (optional `Type: user|feedback|project|reference` prefix selects the type).",
			runtime,
		);
	}
	const backend = await resolveMemoryBackend(runtime.settings);
	if (!backend.save) {
		return usage(`The ${backend.id} memory backend does not support saving memories.`, runtime);
	}
	try {
		const result = await backend.save(
			{ agentDir: runtime.settings.getAgentDir(), cwd: runtime.cwd, session: runtime.session },
			{ content },
		);
		await runtime.output(result.message ?? `Saved ${result.stored} memor${result.stored === 1 ? "y" : "ies"}.`);
	} catch (error) {
		return usage(`Remember failed: ${errorMessage(error)}`, runtime);
	}
	return commandConsumed();
}

async function handleDream(_command: ParsedSlashCommand, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const backend = await resolveMemoryBackend(runtime.settings);
	const runDream = async (): Promise<void> => {
		try {
			await backend.enqueue(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
		} catch (error) {
			await runtime.output(`Dream failed: ${errorMessage(error)}`);
			return;
		}
		await runtime.output("Dream complete: memories reviewed, consolidated, and indexed.");
	};
	// Consolidation makes an LLM call — background-dispatch under RPC so the
	// serialized command queue stays free (same pattern as /compact).
	if (runtime.runCommandInBackground) {
		runtime.runCommandInBackground(runDream);
		return commandConsumed();
	}
	await runDream();
	return commandConsumed();
}

export const BUILTIN_MEMORY_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "remember",
		icon: "pencil",
		description: "Save a memory to the active memory backend",
		acpDescription: "Save a memory",
		inlineHint: "<text>",
		allowArgs: true,
		handle: handleRemember,
	},
	{
		name: "dream",
		icon: "wave",
		description: "Run memory consolidation now (review, merge, prune, re-index)",
		acpDescription: "Run memory consolidation now",
		handle: handleDream,
	},
];
