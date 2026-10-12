/**
 * Production model wiring for the evolution transports: resolves configured
 * model ids (skillEvolution.judgeModel / optimizerModel, falling back to the
 * advisor role) against the ModelRegistry and adapts `streamSimple` into the
 * trainer's `ModelTransport`. This is the ONLY file that touches pi-ai, so
 * swapping the inference backend means touching one file.
 *
 * Credentials go through the central auth-retry resolver (oauth/managed/
 * keyring providers included) — without it every non-env provider 401s.
 * Output budget is per-role (the original's max_tokens: judge answers are
 * small JSON, optimizer edits need room; 2048 across the board truncated
 * JSON arrays into parse failures). Text accumulated from `text_delta` is
 * kept even when the stream ends in `error`, matching the original's
 * "non-zero exit but non-empty stdout still gets scored" contract.
 */
import { streamSimple, type AssistantMessage, type Api, type Context, type Model } from "@oh-my-pi/pi-ai";

import { createApiKeyResolver } from "../config/api-key-resolver";
import type { Settings } from "../config/settings";
import { getModelMatchPreferences, resolveModelFromSettings, resolveModelFromString } from "../config/model-resolver";
import type { ModelRegistry } from "../config/model-registry";
import type { ModelTransport } from "./judge";

export interface EvolutionModelDeps {
	settings: Settings;
	modelRegistry: ModelRegistry;
	allowedModels: Model<Api>[];
}

/** Resolve a model id string ("" → advisor role → default chain). */
export function resolveEvolutionModel(modelId: string, deps: EvolutionModelDeps): Model<Api> | undefined {
	const trimmed = modelId.trim();
	if (trimmed) {
		const resolved = resolveModelFromString(trimmed, deps.allowedModels, getModelMatchPreferences(deps.settings));
		if (resolved) return resolved;
	}
	// Fall back to the advisor role (second-model discipline), then defaults.
	const advisorRole = deps.settings.getModelRole("advisor");
	if (advisorRole) {
		const resolved = resolveModelFromString(advisorRole, deps.allowedModels, getModelMatchPreferences(deps.settings));
		if (resolved) return resolved;
	}
	return resolveModelFromSettings({ settings: deps.settings, availableModels: deps.allowedModels });
}

export const EVOLUTION_MAX_TOKENS = {
	judge: 2048,
	optimizer: 8192,
	target: 8192,
} as const;

/** Adapt one resolved model into a one-shot transport (collect full text). */
export function makeTransport(
	model: Model<Api>,
	modelRegistry: ModelRegistry,
	opts: { maxTokens?: number } = {},
): ModelTransport {
	// Central a/b/c auth-retry policy per provider (oauth refresh, rotation).
	const apiKey = createApiKeyResolver(modelRegistry, model.provider);
	return async ({ system, prompt, signal }) => {
		const context: Context = {
			systemPrompt: [system],
			messages: [{ role: "user", content: prompt, timestamp: Date.now(), attribution: "user" }],
		};
		const stream = streamSimple(model, context, {
			apiKey,
			signal,
			maxTokens: opts.maxTokens ?? EVOLUTION_MAX_TOKENS.target,
		});
		let message: AssistantMessage | undefined;
		// text_delta accumulation: a stream that ends in `error` still carries
		// usable partial output — score what arrived instead of discarding it.
		let partialText = "";
		for await (const event of stream) {
			if (event.type === "text_delta") partialText += event.delta;
			else if (event.type === "done") message = event.message;
			else if (event.type === "error") message = event.error;
		}
		const text =
			(message?.content ?? [])
				.map(block => (block.type === "text" ? block.text : ""))
				.join("")
				.trim() || partialText.trim();
		if (!text) throw new Error(`evolution transport: empty completion from ${model.provider}/${model.id}`);
		return text;
	};
}
