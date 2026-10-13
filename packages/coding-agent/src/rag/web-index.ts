/**
 * web_index tool: fetch a URL through the shared read-url pipeline and persist
 * it into the RAG store as embedded chunks for later semantic recall.
 *
 * Degrades honestly instead of pretending: when no embedder backend is
 * configured, or the web-cache DB cannot be opened, nothing is stored and the
 * tool reports the unmet goal (isError) alongside the fetch/chunk work that
 * did succeed — so the model never believes a page is recallable when it is not.
 */

import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import webIndexDescription from "../prompts/tools/web-index.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import { fetchReadUrl } from "../tools/fetch";
import { openWebCacheDb } from "../web/search/cache";
import { chunkDocument } from "./chunker";
import { getRagEmbedder } from "./embeddings";
import { type ReplaceRagChunk, replaceChunks } from "./store";

/** Namespace chunks land in when the caller does not name one. */
export const DEFAULT_WEB_INDEX_NAMESPACE = "web";

/** Tool parameters schema. */
export const webIndexSchema = type({
	url: "string",
	namespace: "string?",
	max_chunks: "number?",
});

export type WebIndexParams = typeof webIndexSchema.infer;

/** What indexing produced or attempted; `reason` explains a degraded no-op. */
export interface WebIndexDetails {
	url: string;
	namespace: string;
	chunks: number;
	chars: number;
	model?: string;
	dim?: number;
	reason?: string;
}

/** Result of fetching the page to index. */
export interface FetchedPage {
	content: string;
	finalUrl: string;
}

/**
 * Page-fetcher seam. Production resolves through {@link fetchReadUrl} (full
 * read-url pipeline: renderers, fallbacks, URL safety); tests inject a stub.
 */
export type WebIndexFetchPage = (url: string, signal?: AbortSignal) => Promise<FetchedPage>;

function defaultFetchPage(session: ToolSession): WebIndexFetchPage {
	return async (url, signal) => {
		const entry = await fetchReadUrl(session, { path: url }, signal);
		return { content: entry.content, finalUrl: entry.details.finalUrl };
	};
}

/** web_index tool implementation. */
export class WebIndexTool implements AgentTool<typeof webIndexSchema, WebIndexDetails> {
	readonly name = "web_index";
	readonly approval = "read" as const;
	readonly label = "Web Index";
	readonly parameters = webIndexSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Index a web page into the RAG store for later semantic recall";

	#session: ToolSession;
	#fetchPage?: WebIndexFetchPage;

	constructor(session: ToolSession, fetchPage?: WebIndexFetchPage) {
		this.#session = session;
		this.#fetchPage = fetchPage;
	}

	get description(): string {
		return webIndexDescription;
	}

	async execute(
		_toolCallId: string,
		params: WebIndexParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<WebIndexDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<WebIndexDetails>> {
		const url = params.url;
		const namespace = params.namespace?.trim() || DEFAULT_WEB_INDEX_NAMESPACE;

		const failure = (
			text: string,
			reason: string,
			counts?: { chunks: number; chars: number },
		): AgentToolResult<WebIndexDetails> => ({
			content: [{ type: "text", text }],
			details: { url, namespace, chunks: counts?.chunks ?? 0, chars: counts?.chars ?? 0, reason },
			isError: true,
		});

		let page: FetchedPage;
		try {
			page = await (this.#fetchPage ?? defaultFetchPage(this.#session))(url, signal);
		} catch (error) {
			if (signal?.aborted) throw error;
			const message = error instanceof Error ? error.message : String(error);
			return failure(`Indexing failed: could not fetch ${url}: ${message}`, "fetch failed");
		}

		const maxChunks = params.max_chunks !== undefined ? Math.max(0, Math.trunc(params.max_chunks)) : undefined;
		const chunks = chunkDocument(page.content).slice(0, maxChunks ?? Infinity);
		const chars = chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
		const counts = { chunks: chunks.length, chars };
		if (chunks.length === 0) {
			return maxChunks === 0
				? failure(`max_chunks is 0: nothing to index from ${url}.`, "max_chunks is 0", counts)
				: failure(`No indexable content returned from ${page.finalUrl}.`, "empty content", counts);
		}

		const embedder = await getRagEmbedder();
		if (!embedder) {
			return failure(
				`Indexing unavailable: no embedding backend is configured, so nothing was stored. Chunked ${chunks.length} chunks (${chars} chars) from ${url} into namespace "${namespace}".`,
				"no embedder",
				counts,
			);
		}

		const db = openWebCacheDb();
		if (!db) {
			return failure(
				`Indexing unavailable: the web cache database could not be opened, so nothing was stored. Chunked ${chunks.length} chunks (${chars} chars) from ${url}.`,
				"web cache db unavailable",
				counts,
			);
		}

		try {
			const vectors = await embedder.embed(chunks.map(chunk => chunk.text));
			if (vectors.length !== chunks.length) {
				return failure(
					`Indexing failed: embedder returned ${vectors.length} vectors for ${chunks.length} chunks.`,
					"embedding count mismatch",
					counts,
				);
			}
			const rows: ReplaceRagChunk[] = chunks.map((chunk, i) => ({
				index: chunk.index,
				title: chunk.title,
				text: chunk.text,
				embedding: vectors[i]!,
				model: embedder.model,
				dim: embedder.dim,
			}));
			if (!replaceChunks(db, namespace, url, rows)) {
				return failure(
					`Indexing failed: could not write chunks for ${url} to namespace "${namespace}".`,
					"store write failed",
					counts,
				);
			}
			return {
				content: [
					{
						type: "text",
						text: `Indexed ${chunks.length} chunks (${chars} chars) from ${url} into namespace "${namespace}" (model ${embedder.model}, dim ${embedder.dim}).`,
					},
				],
				details: { url, namespace, chunks: chunks.length, chars, model: embedder.model, dim: embedder.dim },
			};
		} catch (error) {
			if (signal?.aborted) throw error;
			const message = error instanceof Error ? error.message : String(error);
			return failure(`Indexing failed: embedding chunks from ${url} failed: ${message}`, "embedding failed", counts);
		}
	}
}
