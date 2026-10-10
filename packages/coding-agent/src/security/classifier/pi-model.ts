/**
 * Default pi-ai model call for the auto-mode classifier, mirroring the
 * completeSimple usage in src/commit/conventional/inference.ts. Kept in its
 * own module so classifier/ modules other than this one stay free of pi-ai
 * imports and unit tests that inject a fake never load it. Hosts pick the
 * model here — pass a cheap/fast tier (the commit pipeline's "smol" role is
 * the pattern to follow).
 */

import { completeSimple, type Api, type ApiKey, type Model } from "@oh-my-pi/pi-ai";
import type { ClassifierModelCall } from "./yolo-classifier";

export type PiModelCallOptions = {
	/** pi-ai model to call (Model<Api>); loosely typed for the factory boundary. */
	model: unknown;
	/** Bearer for the model call (ApiKey). */
	apiKey?: unknown;
	/** Output token budget; defaults to 4096 like the classifier's short verdicts. */
	maxTokens?: number;
	/** Abort signal observed for the request. */
	signal?: AbortSignal;
};

function extractText(message: { content: Array<{ type: string; text?: string }> }): string {
	return message.content
		.filter(content => content.type === "text")
		.map(content => content.text ?? "")
		.join("")
		.trim();
}

export function createPiModelCall(options: PiModelCallOptions): ClassifierModelCall {
	const model = options.model as Model<Api>;
	const apiKey = options.apiKey as ApiKey | undefined;
	const sessionId = Bun.randomUUIDv7();
	return async (system, user) => {
		const message = await completeSimple(
			model,
			{
				systemPrompt: system.trim() ? [system] : undefined,
				messages: [{ role: "user", content: user, timestamp: Date.now() }],
			},
			{
				apiKey,
				sessionId,
				maxTokens: options.maxTokens ?? 4096,
				signal: options.signal,
			},
		);
		if (message.stopReason === "error") {
			throw new Error(message.errorMessage ?? "Provider error");
		}
		const text = extractText(message);
		if (!text) {
			throw new Error("Empty model response");
		}
		return text;
	};
}
