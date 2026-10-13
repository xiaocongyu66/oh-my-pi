/**
 * Embedding backend for the web_search RAG pipeline.
 *
 * `getRagEmbedder` resolves the configured backend per call: an injected test
 * double wins, otherwise settings pick between the local fastembed subprocess
 * (a thin wrapper over `mnemopiEmbedClient`, initialized once and memoized),
 * an OpenAI-compatible `/embeddings` endpoint, or nothing. Unavailability
 * returns `null` instead of throwing — a missing embedder disables RAG
 * quietly rather than breaking search.
 */

import { embeddingDimFor } from "@oh-my-pi/pi-mnemopi/core/embeddings";
import { fetchWithRetry, logger } from "@oh-my-pi/pi-utils";
import type { ScopeLike } from "../config/registry";
import { Settings, isSettingsInitialized, settings as globalSettings } from "../config/settings";
import { type MnemopiSubprocessEmbeddingModel, mnemopiEmbedClient } from "../mnemopi/embed-client";
import {
	cfgWebSearchRagEmbedding,
	cfgWebSearchRagEmbeddingApiKey,
	cfgWebSearchRagEmbeddingApiUrl,
	cfgWebSearchRagEnabled,
} from "../web/settings";

export interface RagEmbedder {
	/** Model identifier as recorded in stored rows (`rag_chunks.model`). */
	readonly model: string;
	/** Vector length; corrected from the first real vector when the id is not in the dim table. */
	readonly dim: number;
	embed(texts: readonly string[]): Promise<Float32Array[]>;
}

/** fastembed model id, loaded by the mnemopi embeddings subprocess. */
const DEFAULT_LOCAL_MODEL = "fast-bge-base-en-v1.5";
/** OpenAI-compatible default for `api` mode; the real dim comes from the response. */
const DEFAULT_API_MODEL = "text-embedding-3-small";

let injectedEmbedder: RagEmbedder | null | undefined;
let localEmbedderPromise: Promise<RagEmbedder | null> | null = null;

/**
 * Inject a test double, `null` to force "unavailable", or `undefined` to clear
 * the override (the extra reset state is what lets tests restore the default
 * settings-driven behavior after an injection).
 */
export function setRagEmbedderForTests(embedder: RagEmbedder | null | undefined): void {
	injectedEmbedder = embedder;
}

class LocalRagEmbedder implements RagEmbedder {
	readonly model: string;
	#dim: number;
	#model: MnemopiSubprocessEmbeddingModel;

	constructor(model: string, modelHandle: MnemopiSubprocessEmbeddingModel) {
		this.model = model;
		// `embeddingDimFor` keys on HuggingFace names; `fast-*` ids fall through
		// to its generic default, so the initial value is provisional and the
		// first real vector's length wins.
		this.#dim = embeddingDimFor(model);
		this.#model = modelHandle;
	}

	get dim(): number {
		return this.#dim;
	}

	async embed(texts: readonly string[]): Promise<Float32Array[]> {
		const vectors: Float32Array[] = [];
		if (texts.length === 0) return vectors;
		// The worker yields one batch per embed round-trip; aggregate them all.
		for await (const batch of this.#model.embed([...texts])) {
			for (const row of batch) {
				const vector = Float32Array.from(row);
				if (vectors.length === 0 && vector.length > 0 && vector.length !== this.#dim) {
					this.#dim = vector.length;
				}
				vectors.push(vector);
			}
		}
		return vectors;
	}
}

class ApiRagEmbedder implements RagEmbedder {
	readonly model: string;
	#baseUrl: string;
	#apiKey: string | undefined;
	#dim: number;

	constructor(model: string, baseUrl: string, apiKey: string | undefined) {
		this.model = model;
		this.#baseUrl = baseUrl;
		this.#apiKey = apiKey;
		this.#dim = embeddingDimFor(model);
	}

	get dim(): number {
		return this.#dim;
	}

	async embed(texts: readonly string[]): Promise<Float32Array[]> {
		if (texts.length === 0) return [];
		const url = `${this.#baseUrl.replace(/\/+$/, "")}/embeddings`;
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		// Local/proxy setups legitimately run keyless: no header at all.
		if (this.#apiKey) headers.Authorization = `Bearer ${this.#apiKey}`;
		const response = await fetchWithRetry(url, {
			method: "POST",
			headers,
			body: JSON.stringify({ model: this.model, input: texts }),
			maxAttempts: 3,
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) {
			throw new Error(`rag embedding API error (${response.status}) from ${url}`);
		}
		const payload = (await response.json()) as { data?: Array<{ embedding: number[] }> };
		const rows = payload.data;
		if (!rows || rows.length !== texts.length) {
			throw new Error(`rag embedding API returned ${rows?.length ?? 0} vectors for ${texts.length} inputs`);
		}
		const vectors = rows.map(row => Float32Array.from(row.embedding));
		const first = vectors[0];
		if (first && first.length > 0 && first.length !== this.#dim) this.#dim = first.length;
		return vectors;
	}
}

async function createLocalEmbedder(): Promise<RagEmbedder | null> {
	try {
		const model = await mnemopiEmbedClient.initialize(DEFAULT_LOCAL_MODEL, undefined);
		if (!model) {
			logger.debug("rag: local embedder unavailable");
			return null;
		}
		return new LocalRagEmbedder(DEFAULT_LOCAL_MODEL, model);
	} catch (error) {
		logger.debug("rag: local embedder failed to start", {
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

function createApiEmbedder(scope: ScopeLike): RagEmbedder | null {
	const configured = cfgWebSearchRagEmbeddingApiUrl.get(scope) ?? "";
	const envUrl = Bun.env.MNEMOPI_EMBEDDING_API_URL ?? "";
	const baseUrl = (configured.trim() !== "" ? configured : envUrl).trim();
	if (baseUrl === "") return null;
	const apiKey = cfgWebSearchRagEmbeddingApiKey.get(scope);
	return new ApiRagEmbedder(DEFAULT_API_MODEL, baseUrl, apiKey ? apiKey : undefined);
}

function defaultScope(): ScopeLike {
	// Prefer the global singleton; before `Settings.init()` (early startup,
	// unit tests) fall back to an in-memory instance so defaults and env vars
	// still resolve without touching disk.
	if (isSettingsInitialized()) return globalSettings;
	return Settings.isolated();
}

export async function getRagEmbedder(scope?: ScopeLike): Promise<RagEmbedder | null> {
	if (injectedEmbedder !== undefined) return injectedEmbedder;
	const active = scope ?? defaultScope();
	if (!cfgWebSearchRagEnabled.get(active)) return null;
	const mode = cfgWebSearchRagEmbedding.get(active);
	if (mode === "off") return null;
	if (mode === "api") return createApiEmbedder(active);
	// The subprocess bootstrap is expensive, so the attempt is cached across
	// calls — including a failed one, so a broken native runtime cannot
	// re-attempt a multi-minute bootstrap on every search.
	localEmbedderPromise ??= createLocalEmbedder();
	return localEmbedderPromise;
}
