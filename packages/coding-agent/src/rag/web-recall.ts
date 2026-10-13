/**
 * web_recall tool: semantic vector search over chunks previously stored by
 * web_index. Exact cosine KNN over the namespace's stored embeddings — no
 * network fetch, everything comes from the local web-cache DB.
 *
 * Unavailability is reported, never silent: a missing embedder or DB returns
 * an explicit "unavailable" result so the model knows recall (not indexing)
 * is what is broken.
 */

import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { buildExactVectorIndex, searchExactVectorIndex } from "@oh-my-pi/pi-mnemopi/core/vector-index";
import { truncate } from "@oh-my-pi/pi-utils";
import webRecallDescription from "../prompts/tools/web-recall.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import { finalizeOutput } from "../web/scrapers/types";
import { openWebCacheDb } from "../web/search/cache";
import { getRagEmbedder } from "./embeddings";
import { listChunks } from "./store";
import { DEFAULT_WEB_INDEX_NAMESPACE } from "./web-index";

const DEFAULT_RECALL_LIMIT = 6;
/** Snippet length per match in the LLM-facing output. */
const SNIPPET_CHARS = 300;

/** Tool parameters schema. */
export const webRecallSchema = type({
	query: "string",
	namespace: "string?",
	limit: "number?",
});

export type WebRecallParams = typeof webRecallSchema.infer;

export interface WebRecallMatch {
	url: string;
	chunkIndex: number;
	score: number;
	title?: string;
}

export interface WebRecallDetails {
	matches: WebRecallMatch[];
	namespace: string;
	model?: string;
}

/** web_recall tool implementation. */
export class WebRecallTool implements AgentTool<typeof webRecallSchema, WebRecallDetails> {
	readonly name = "web_recall";
	readonly approval = "read" as const;
	readonly label = "Web Recall";
	readonly parameters = webRecallSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Semantic recall over previously indexed web pages";

	// The session is accepted for BUILTIN_TOOLS factory symmetry; recall reads
	// only process-global embedder + cache state.
	constructor(_session: ToolSession) {}

	get description(): string {
		return webRecallDescription;
	}

	async execute(
		_toolCallId: string,
		params: WebRecallParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<WebRecallDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<WebRecallDetails>> {
		const namespace = params.namespace?.trim() || DEFAULT_WEB_INDEX_NAMESPACE;
		const limit = Math.max(1, Math.trunc(params.limit ?? DEFAULT_RECALL_LIMIT));

		const unavailable = (text: string, model?: string): AgentToolResult<WebRecallDetails> => ({
			content: [{ type: "text", text }],
			details: { matches: [], namespace, model },
			isError: true,
		});

		const embedder = await getRagEmbedder();
		if (!embedder) {
			return unavailable(
				`Recall unavailable: no embedding backend is configured, so indexed chunks cannot be searched.`,
			);
		}

		const db = openWebCacheDb();
		if (!db) {
			return unavailable(
				`Recall unavailable: the web cache database could not be opened, so indexed chunks cannot be searched.`,
				embedder.model,
			);
		}

		const rows = listChunks(db, namespace);
		if (rows.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: `No indexed chunks in namespace "${namespace}". Index pages first with web_index.`,
					},
				],
				details: { matches: [], namespace, model: embedder.model },
			};
		}

		// Rows stored without vectors (or under a differently sized backend) are
		// unsearchable but do not fail the query — they are simply skipped.
		const searchable = rows.filter(row => row.embedding !== null && row.embedding.length === embedder.dim);
		if (searchable.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: `No searchable chunks in namespace "${namespace}": ${rows.length} stored chunks have no embedding for the current backend (model ${embedder.model}, dim ${embedder.dim}). Re-index the pages with web_index.`,
					},
				],
				details: { matches: [], namespace, model: embedder.model },
			};
		}

		try {
			const index = buildExactVectorIndex(
				searchable.map(row => ({ id: row.id, vector: Array.from(row.embedding!) })),
			);
			const [queryVector] = await embedder.embed([params.query]);
			if (!queryVector || queryVector.length === 0) {
				return unavailable(
					`Recall failed: the embedding backend returned no vector for the query.`,
					embedder.model,
				);
			}
			const hits = searchExactVectorIndex(index, Array.from(queryVector), limit);
			if (hits.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No matches for the query in namespace "${namespace}" (${searchable.length} chunks searched).`,
						},
					],
					details: { matches: [], namespace, model: embedder.model },
				};
			}

			const byId = new Map(searchable.map(row => [row.id, row]));
			const lines: string[] = [];
			const matches: WebRecallMatch[] = [];
			for (const [i, hit] of hits.entries()) {
				const row = byId.get(hit.id);
				if (!row) continue;
				lines.push(
					`[${i + 1}] ${row.title ?? row.url}`,
					`    ${row.url}`,
					`    score ${hit.score.toFixed(2)}`,
					`    ${truncate(row.text, SNIPPET_CHARS)}`,
				);
				matches.push(
					row.title === null
						? { url: row.url, chunkIndex: row.chunkIndex, score: hit.score }
						: { url: row.url, chunkIndex: row.chunkIndex, score: hit.score, title: row.title },
				);
			}

			const text = finalizeOutput(lines.join("\n")).content;
			return {
				content: [{ type: "text", text }],
				details: { matches, namespace, model: embedder.model },
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return unavailable(`Recall failed: searching namespace "${namespace}" failed: ${message}`, embedder.model);
		}
	}
}
