/**
 * Production model wiring for the evolution transports: resolves configured
 * model ids (skillEvolution.judgeModel / optimizerModel, falling back to the
 * advisor role) against the ModelRegistry and adapts `streamSimple` into the
 * trainer's `ModelTransport`. This is the ONLY file that touches pi-ai, so
 * swapping the inference backend means touching one file.
 */
import { streamSimple, type AssistantMessage, type Api, type Context, type Model } from "@oh-my-pi/pi-ai";

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

/** Adapt one resolved model into a one-shot transport (collect full text). */
export function makeTransport(model: Model<Api>): ModelTransport {
	return async ({ system, prompt, signal }) => {
		const context: Context = {
			system,
			messages: [{ role: "user", content: prompt, timestamp: Date.now(), attribution: "user" }],
		};
		const stream = streamSimple(model, context, { signal, maxTokens: 2048 });
		let message: AssistantMessage | undefined;
		for await (const event of stream) {
			if (event.type === "done") message = event.message;
		}
		const text = (message?.content ?? [])
			.map(block => (block.type === "text" ? block.text : ""))
			.join("")
			.trim();
		if (!text) throw new Error(`evolution transport: empty completion from ${model.provider}/${model.id}`);
		return text;
	};
}
