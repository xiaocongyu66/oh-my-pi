/**
 * Unified Web Search Tool
 *
 * Single tool supporting Anthropic, Perplexity, Exa, Brave, Jina, Kimi, Gemini, Codex, Tavily, Kagi, Z.AI, SearXNG, and Synthetic
 * providers with provider-specific parameters exposed conditionally.
 */

import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Api, AuthStorage, Model } from "@oh-my-pi/pi-ai";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { formatAge, formatCount, logger, prompt, truncate } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../config/model-registry";
import { type RoleChainCandidate, resolveModelRoleValue, resolveRoleChain } from "../../config/model-resolver";
import { roleCandidatePool } from "../../config/model-roles";
import { settings } from "../../config/settings";
import type { CustomTool, CustomToolContext } from "../../extensibility/custom-tools/types";
import webSearchSystemPrompt from "../../prompts/system/web-search.md" with { type: "text" };
import webSearchDescription from "../../prompts/tools/web-search.md" with { type: "text" };
import { resolveConfiguredModelTarget } from "../../session/role-models";
import { discoverAuthStorage } from "../../sdk";
import type { ToolSession } from "../../tools";
import { throwIfAborted } from "../../tools/tool-errors";
import { getRagEmbedder } from "../../rag/embeddings";
import {
	cfgWebSearchAggregateDeadlineMs,
	cfgWebSearchAggregateFanout,
	cfgWebSearchCacheEnabled,
	cfgWebSearchCacheTtlSec,
} from "../../tools/settings";
import {
	formatSearchProviderFailure,
	formatSearchProviderFailures,
	getGroundedSearchProvider,
	getSearchProvider,
	type SearchProvider,
} from "./provider";
import { rankXAIProviders, targetsX, xaiModelChain, xSearchAvailable } from "./providers/xai";
import { applyQueryConstraints, parseSearchQuery } from "./query";
import type { SearchModality } from "./providers/base";
import type { WebSearchSessionState } from "./session-state";
import { resolveAggregateCandidates, runAggregate, type AggregateEngineOutcome } from "./aggregate";
import { getCachedSearch, openWebCacheDb, putCachedSearch, searchCacheKey } from "./cache";
import type { AggregateResult } from "./normalize";
import { lookupSemanticCache, type SemanticLookup, storeSemanticQuery } from "./semantic-cache";
import { augmentSourcesWithImageDescriptions, createImageDescriber } from "./vision-describe";
import {
	DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS,
	MAX_WEB_SEARCH_TIMEOUT_SECONDS,
	SearchProviderError,
	type SearchResponse,
	type SearchResultDetails,
} from "./types";

import { cfgProvidersAntigravityEndpoint, cfgProvidersWebSearchTimeoutSeconds } from "../../session/settings";

/** Web search tool parameters schema */
export const webSearchSchema = type({
	query: "string",
	recency: "'day' | 'week' | 'month' | 'year'?",
	limit: "number?",
	max_tokens: "number?",
	temperature: "number?",
	num_search_results: "number?",
	mode: "'fallback' | 'aggregate'?",
	modality: "'web' | 'news' | 'images' | 'videos' | 'scholar' | 'code' | 'archive'?",
	no_cache: "boolean?",
});

export type SearchToolParams = typeof webSearchSchema.infer;

export interface SearchQueryParams extends SearchToolParams {
	model?: string;
}

/** Format response for LLM consumption. `notes` lead the output (e.g. relaxed-constraint warnings). */
function formatForLLM(response: SearchResponse, notes: readonly string[] = []): string {
	const parts: string[] = [];
	for (const note of notes) {
		parts.push(`Note: ${note}`);
	}

	if (response.answer) {
		parts.push(response.answer);
		if (response.sources.length > 0) {
			parts.push("\n## Sources");
			parts.push(formatCount("source", response.sources.length));
		}
	}

	for (const [i, src] of response.sources.entries()) {
		const age = formatAge(src.ageSeconds) || src.publishedDate;
		const agePart = age ? ` (${age})` : "";
		parts.push(`[${i + 1}] ${src.title}${agePart}\n    ${src.url}`);
		if (src.snippet) {
			parts.push(`    ${truncate(src.snippet, 240)}`);
		}
	}

	if (response.citations && response.citations.length > 0) {
		parts.push("\n## Citations");
		parts.push(formatCount("citation", response.citations.length));
		for (const [i, citation] of response.citations.entries()) {
			const title = citation.title || citation.url;
			parts.push(`[${i + 1}] ${title}\n    ${citation.url}`);
			if (citation.citedText) {
				parts.push(`    ${truncate(citation.citedText, 240)}`);
			}
		}
	}

	if (response.relatedQuestions && response.relatedQuestions.length > 0) {
		parts.push("\n## Related");
		parts.push(formatCount("question", response.relatedQuestions.length));
		for (const q of response.relatedQuestions) {
			parts.push(`- ${q}`);
		}
	}

	if (response.searchQueries && response.searchQueries.length > 0) {
		parts.push(`Search queries: ${response.searchQueries.length}`);
		for (const query of response.searchQueries.slice(0, 3)) {
			parts.push(`- ${truncate(query, 120)}`);
		}
	}

	return parts.join("\n");
}

function hasRenderableSearchContent(response: SearchResponse): boolean {
	if (response.answer?.trim()) return true;
	if (response.sources.length > 0) return true;
	if (response.citations?.length) return true;
	if (response.relatedQuestions?.some(question => question.trim())) return true;
	if (response.searchQueries?.some(query => query.trim())) return true;
	return false;
}

interface ExecuteSearchOptions {
	authStorage: AuthStorage;
	modelRegistry?: ModelRegistry;
	sessionId?: string;
	/** The session's active model; `web/hosted` searches through it. */
	sessionModel?: Model<Api>;
	/** `/search` runtime overrides: hosted search model, multimodal parsing, disabled engines. */
	sessionSearchState?: WebSearchSessionState;
	signal?: AbortSignal;
}

function isHostedPlaceholder(model: Model<Api>): boolean {
	return model.provider === "web" && model.id === "hosted";
}

/**
 * Expand the `web/hosted` placeholder into models on the session's own
 * provider, which bill the credential the session already uses: first the
 * session model's cheaper `webSearchModel` swap, then the session model itself.
 * A swap the host does not expose is skipped; a failing swap falls through to
 * the session model. Left unexpanded when neither can search.
 */
function expandHostedCandidate(
	candidate: RoleChainCandidate,
	sessionModel: Model<Api> | undefined,
	pool: Model<Api>[],
): RoleChainCandidate[] {
	if (!isHostedPlaceholder(candidate.model) || !sessionModel) return [candidate];
	const swap = resolveConfiguredModelTarget(sessionModel.webSearchModel, sessionModel, pool);
	const models = [swap, sessionModel].filter(
		(model, index, all): model is Model<Api> => !!model?.webSearch && all.indexOf(model) === index,
	);
	if (models.length === 0) return [candidate];
	return models.map(model => ({ ...candidate, model }));
}

/**
 * Move the chain's xAI-grounded candidates to the front, keeping their order,
 * or prepend {@link xaiModelChain} when the chain has none. Unchanged without
 * xAI credentials.
 */
function preferXAI(chain: RoleChainCandidate[], modelRegistry: ModelRegistry): RoleChainCandidate[] {
	const xai = chain.filter(candidate => candidate.model.webSearch === "xai");
	if (xai.length > 0) return [...xai, ...chain.filter(candidate => candidate.model.webSearch !== "xai")];
	return [...xaiModelChain(modelRegistry, settings).map(model => ({ model, explicit: false })), ...chain];
}

/** Resolve a `provider/id` selector from the `/search` multimodal panel against the registry. */
function findModelBySelector(selector: string, modelRegistry: ModelRegistry): Model<Api> | undefined {
	const slash = selector.indexOf("/");
	if (slash <= 0 || slash === selector.length - 1) return undefined;
	return modelRegistry.find(selector.slice(0, slash), selector.slice(slash + 1));
}

/**
 * Multimodal parsing for image-modality results: when the session enabled it
 * via `/search`, ask the chosen vision model to describe each image result.
 * Best effort by contract — a missing/unresolvable model or any describe
 * failure leaves the response untouched.
 */
async function augmentImageSources(
	response: SearchResponse,
	params: SearchQueryParams,
	options: ExecuteSearchOptions,
): Promise<SearchResponse> {
	const state = options.sessionSearchState;
	const modelRegistry = options.modelRegistry;
	if (!state?.multimodalModel || !modelRegistry) return response;
	const model = findModelBySelector(state.multimodalModel, modelRegistry);
	if (!model) {
		logger.debug("web_search: multimodal model selector unresolved", { selector: state.multimodalModel });
		return response;
	}
	try {
		const apiKey = await modelRegistry.getApiKeyForProvider(model.provider, options.sessionId);
		const described = await augmentSourcesWithImageDescriptions(
			response.sources,
			createImageDescriber({ model, apiKey, signal: options.signal }),
		);
		if (described === response.sources) return response;
		return { ...response, sources: described };
	} catch (error) {
		logger.debug("web_search: multimodal image description failed", { error: String(error) });
		return response;
	}
}

/**
 * Aggregate-mode entry: fan out to the modality's engines, dedup, and rank.
 * Runs before any role-chain resolution — the aggregate candidate table
 * (`MODALITY_ENGINES`) replaces the role chain entirely.
 */
async function executeAggregateSearch(
	params: SearchQueryParams,
	options: {
		authStorage: AuthStorage;
		modelRegistry: ModelRegistry;
		signal?: AbortSignal;
		timeoutMs: number;
		disabledEngines?: ReadonlySet<string>;
	},
): Promise<{ content: Array<{ type: "text"; text: string }>; details: SearchResultDetails }> {
	const { authStorage, modelRegistry, signal } = options;
	const notes: string[] = [];
	let modality: SearchModality = params.modality ?? "web";

	let deadlineMs = 6_000;
	let fanout = 5;
	let ttlMs = 900_000;
	let cacheEnabled = true;
	try {
		deadlineMs = cfgWebSearchAggregateDeadlineMs.get(settings);
		fanout = cfgWebSearchAggregateFanout.get(settings);
		cacheEnabled = cfgWebSearchCacheEnabled.get(settings);
		ttlMs = cfgWebSearchCacheTtlSec.get(settings) * 1_000;
	} catch {
		// Settings not initialized — keep defaults for one-shot callers.
	}
	const noCache = params.no_cache === true || !cacheEnabled;

	const resolve = () =>
		resolveAggregateCandidates(modality, authStorage, modelRegistry, {
			noCache: params.no_cache === true,
			disabledEngines: options.disabledEngines,
		});
	let resolution = await resolve();
	// A vertical with no live engines degrades to the web table rather than failing.
	if (resolution.usable.length === 0 && modality !== "web") {
		notes.push(`no engines available for modality "${modality}"; fell back to web`);
		modality = "web";
		resolution = await resolve();
	}

	if (resolution.usable.length === 0) {
		const message = "No web search engines available for aggregate search.";
		return {
			content: [{ type: "text" as const, text: `Error: ${message}` }],
			details: { response: { provider: "none", sources: [] }, error: message },
		};
	}

	// Query-level cache (plan D5): the merged aggregate list is replayable as a
	// whole, keyed on the full query. Exact hit replays it directly; a miss is
	// matched semantically against recent query vectors. Everything here is
	// best-effort — any failure degrades to the plain fan-out below.
	const db = noCache ? null : openWebCacheDb();
	const aggregateCacheKey = db
		? searchCacheKey(["aggregate", modality, params.query, params.limit, params.recency])
		: null;
	let semantic: SemanticLookup | null = null;
	let replay: { sources: AggregateResult[]; note: string } | null = null;
	if (db && aggregateCacheKey) {
		try {
			const exactHit = getCachedSearch<AggregateResult[]>(aggregateCacheKey, ttlMs);
			if (exactHit && exactHit.payload.length > 0) {
				replay = { sources: exactHit.payload, note: "cached (exact query match)" };
			} else {
				semantic = await lookupSemanticCache(db, params.query, modality, ttlMs);
				if (semantic.hit) {
					replay = {
						sources: semantic.hit.sources,
						note: `cached-semantic (score=${semantic.hit.score.toFixed(2)}, from "${semantic.hit.originalQuery}")`,
					};
				}
			}
		} catch (err) {
			logger.debug("aggregate: query-level cache lookup failed", { err: String(err) });
		}
	}
	if (replay) {
		throwIfAborted(signal);
		const header = `[aggregate: ${modality} · cached · ${replay.sources.length} results]`;
		const text = [header, formatForLLM({ provider: "none", sources: replay.sources }, [...notes, replay.note])].join(
			"\n",
		);
		return {
			content: [{ type: "text" as const, text }],
			details: { response: { provider: "none", sources: replay.sources } },
		};
	}

	// hdsearch engine.ts:172 — aggregate fans out to the first N usable engines.
	const fannedOut = resolution.usable.slice(0, Math.max(1, fanout));
	const aggregate = await runAggregate(
		{
			query: params.query,
			parsedQuery: parseSearchQuery(params.query),
			limit: params.limit,
			recency: params.recency,
			modality,
			systemPrompt: webSearchSystemPrompt,
			signal,
			timeoutMs: options.timeoutMs,
			authStorage,
			modelRegistry,
		},
		fannedOut,
		{ deadlineMs, ttlMs, noCache },
	);
	throwIfAborted(signal);

	// Query-level cache write (plan D5): store the merged list under the query
	// key and index the query vector so later rewrites can replay it. Non-empty
	// results only; failures are swallowed — a broken cache never surfaces.
	if (db && aggregateCacheKey && aggregate.results.length > 0) {
		try {
			putCachedSearch(aggregateCacheKey, aggregate.results, ttlMs);
			let embedding = semantic?.embedding ?? null;
			let model = semantic?.model ?? null;
			if (!embedding || !model) {
				const embedder = await getRagEmbedder();
				if (embedder) {
					embedding = (await embedder.embed([params.query]))[0] ?? null;
					model = embedder.model;
				}
			}
			if (embedding && model) {
				storeSemanticQuery(db, params.query, modality, embedding, model, aggregateCacheKey);
			}
		} catch (err) {
			logger.debug("aggregate: query-level cache store failed", { err: String(err) });
		}
	}

	// Engines skipped at resolution time never entered the fan-out; surface them
	// as outcomes so callers see why the engine list is short.
	for (const skip of resolution.skipped) {
		if (!aggregate.enginesUsed.some(engine => engine.engine === skip.engine)) {
			const outcome: AggregateEngineOutcome = {
				engine: skip.engine,
				ok: false,
				count: 0,
				ms: 0,
				cached: false,
				skipped: true,
				error: skip.reason,
			};
			aggregate.enginesUsed.push(outcome);
		}
	}

	const header = `[aggregate: ${modality} · ${fannedOut.length} engines · ${aggregate.results.length} results]`;
	const text = [
		header,
		formatForLLM({ provider: "none", sources: aggregate.results }, [...notes, ...aggregate.notes]),
	].join("\n");
	return {
		content: [{ type: "text" as const, text }],
		details: { response: { provider: "none", sources: aggregate.results } },
	};
}

/** Execute web search */
async function executeSearch(
	_toolCallId: string,
	params: SearchQueryParams,
	options: ExecuteSearchOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: SearchResultDetails }> {
	const { authStorage, sessionId, signal } = options;
	const modelRegistry = options.modelRegistry ?? new ModelRegistry(authStorage, undefined, { settings });

	let timeoutMs = DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS * 1_000;
	try {
		const configuredSeconds = cfgProvidersWebSearchTimeoutSeconds.get(settings);
		if (Number.isFinite(configuredSeconds) && configuredSeconds > 0) {
			timeoutMs = Math.ceil(Math.min(configuredSeconds, MAX_WEB_SEARCH_TIMEOUT_SECONDS) * 1_000);
		}
	} catch {
		// Preserve the default for one-shot callers that do not initialize Settings.
	}

	// Aggregate mode replaces the role chain with the modality engine table;
	// branch before any role-chain resolution work.
	if (params.mode === "aggregate") {
		return executeAggregateSearch(params, {
			authStorage,
			modelRegistry,
			signal,
			timeoutMs,
			disabledEngines: options.sessionSearchState?.disabledEngines,
		});
	}

	const pool = roleCandidatePool("web", settings, modelRegistry);
	// A `/search`-hosted search model overrides the default role chain but never
	// an explicit per-call params.model; it binds exactly like an explicit pick.
	const explicitModel = params.model ?? options.sessionSearchState?.searchModel;
	const candidates = explicitModel
		? (() => {
				const resolved = resolveModelRoleValue(explicitModel, pool, { settings });
				return resolved.model
					? [{ model: resolved.model, explicit: true, thinkingLevel: resolved.thinkingLevel }]
					: [];
			})()
		: resolveRoleChain("web", settings, pool);
	const parsedQuery = parseSearchQuery(params.query);
	let expanded = rankXAIProviders(
		candidates.flatMap(candidate => expandHostedCandidate(candidate, options.sessionModel, pool)),
		candidate => candidate.model,
		settings,
	);
	// Only xAI reaches X posts; X-only queries try it first even when the role prefers another engine.
	if (!explicitModel && targetsX(parsedQuery)) expanded = preferXAI(expanded, modelRegistry);

	// Invariant across candidates; resolve once before walking the role chain.
	let antigravityEndpointMode: "auto" | "production" | "sandbox" | undefined;
	try {
		antigravityEndpointMode = cfgProvidersAntigravityEndpoint.get(settings);
	} catch {
		antigravityEndpointMode = undefined;
	}

	const failures: Array<{ provider: { id: string; label: string }; error: unknown }> = [];
	let availableProviderCount = 0;
	let lastProvider: { id: string; label: string } | undefined;
	let failedResponseProvider: SearchResponse["provider"] = "none";
	for (const candidate of expanded) {
		let provider: SearchProvider | undefined;
		const candidateMeta = { id: candidate.model.id, label: candidate.model.name };
		lastProvider = candidateMeta;
		try {
			const model = candidate.model;
			if (isHostedPlaceholder(model)) {
				if (!candidate.explicit) continue;
				throw new Error("The session model has no web search grounding.");
			}
			if (modelKind(model) === "search") {
				provider = await getSearchProvider(model.id);
			} else if (model.webSearch) {
				provider = await getGroundedSearchProvider(model.webSearch);
			} else {
				throw new Error(`Model ${model.provider}/${model.id} does not support web search`);
			}
			lastProvider = provider;
			const available = candidate.explicit
				? await provider.isExplicitlyAvailable(authStorage, model)
				: await provider.isAvailable(authStorage, model);
			if (!available && !candidate.explicit) continue;
			if (!available && candidate.explicit) {
				throw new SearchProviderError(
					provider.id,
					`${provider.label} web search is unavailable. Configure its credentials or select the automatic provider chain.`,
				);
			}
			availableProviderCount++;
			lastProvider = provider;

			const response = await provider.search({
				query: params.query,
				parsedQuery,
				limit: params.limit,
				recency: params.recency,
				modality: params.modality,
				systemPrompt: webSearchSystemPrompt,
				maxOutputTokens: params.max_tokens,
				numSearchResults: params.num_search_results,
				temperature: params.temperature,
				signal,
				timeoutMs,
				authStorage,
				model,
				thinkingLevel: candidate.thinkingLevel,
				modelRegistry,
				explicit: candidate.explicit,
				sessionId,
				antigravityEndpointMode,
			});

			// A host that silently drops the hosted search tool still answers from the
			// model's weights; without sources that answer is not a search result.
			if (modelKind(model) !== "search" && response.sources.length === 0 && !response.citations?.length) {
				throw new SearchProviderError(
					provider.id,
					`${provider.label} returned no sources; ${model.provider}/${model.id} may not support hosted web search.`,
					204,
				);
			}

			// Lenient constraint pass over whatever the provider returned: enforce
			// site:/inurl:/intitle:/filetype:/date directives the provider could
			// not (or only partially) honor natively, relaxing any dimension that
			// would wipe out every result. Citations/answer text stay untouched.
			let finalResponse = response;
			const constraintNotes: string[] = [];
			if (parsedQuery.hasConstraints && response.sources.length > 0) {
				const filtered = applyQueryConstraints(response.sources, parsedQuery);
				if (filtered.sources.length !== response.sources.length) {
					finalResponse = { ...response, sources: filtered.sources };
				}
				for (const label of filtered.dropped) {
					constraintNotes.push(`no results matched \`${label}\`; the constraint was relaxed`);
				}
			}

			if (!hasRenderableSearchContent(finalResponse)) {
				throw new SearchProviderError(provider.id, `${provider.label} returned no renderable search content.`, 204);
			}

			if (params.modality === "images" && options.sessionSearchState?.multimodalModel) {
				finalResponse = await augmentImageSources(finalResponse, params, options);
			}

			const text = formatForLLM(finalResponse, constraintNotes);

			return {
				content: [{ type: "text" as const, text }],
				details: { response: finalResponse },
			};
		} catch (error) {
			// Surface user-initiated cancellation immediately so the session sees
			// a clean abort instead of a generic "all providers failed" message.
			// Without this, an AbortError from `fetch()` is treated as a provider
			// failure and the loop falls through to the next provider (or to the
			// summary error), masking the cancellation.
			throwIfAborted(signal);
			failedResponseProvider = provider?.id ?? "none";
			failures.push({ provider: provider ?? candidateMeta, error });
		}
	}

	if (availableProviderCount === 0 && failures.length === 0) {
		const message = explicitModel
			? `No web search model matches selector "${explicitModel}".`
			: "No web search model configured.";
		return {
			content: [{ type: "text" as const, text: `Error: ${message}` }],
			details: { response: { provider: "none", sources: [] }, error: message },
		};
	}

	const lastFailure = failures[failures.length - 1];
	const baseMessage = lastFailure
		? formatSearchProviderFailure(lastFailure.error, lastFailure.provider)
		: `Unknown error from ${lastProvider?.label ?? "web search provider"}`;
	const message =
		failures.length > 1 ? `All web search providers failed: ${formatSearchProviderFailures(failures)}` : baseMessage;

	return {
		content: [{ type: "text" as const, text: `Error: ${message}` }],
		details: {
			response: { provider: failedResponseProvider, sources: [] },
			error: message,
		},
	};
}

/**
 * Execute a web search query for CLI/testing workflows.
 *
 * `authStorage` may be omitted; in that case we discover one via the standard
 * factory (`discoverAuthStorage`), which honours `OMP_AUTH_BROKER_URL` and
 * otherwise opens the local SQLite credential store.
 */
export async function runSearchQuery(
	params: SearchQueryParams,
	options: {
		authStorage?: AuthStorage;
		modelRegistry?: ModelRegistry;
		sessionId?: string;
		sessionModel?: Model<Api>;
		sessionSearchState?: WebSearchSessionState;
		signal?: AbortSignal;
	} = {},
): Promise<{ content: Array<{ type: "text"; text: string }>; details: SearchResultDetails }> {
	const createdAuthStorage = options.authStorage || options.modelRegistry ? undefined : await discoverAuthStorage();
	const authStorage = options.authStorage ?? options.modelRegistry?.authStorage ?? createdAuthStorage;
	if (!authStorage) {
		throw new Error("Failed to initialize authentication storage");
	}
	try {
		return await executeSearch("cli-web-search", params, {
			authStorage,
			modelRegistry: options.modelRegistry,
			sessionId: options.sessionId,
			sessionModel: options.sessionModel,
			sessionSearchState: options.sessionSearchState,
			signal: options.signal,
		});
	} finally {
		createdAuthStorage?.close();
	}
}

/** Description without the X operators, for hosts without a model registry. */
const plainDescription = prompt.render(webSearchDescription);

/**
 * Description rendered on first read with a model registry, then reused for
 * the process: re-checking xAI auth per read would rewrite the tool
 * description, and invalidate the prompt cache, whenever auth changes.
 */
let registryDescription: string | undefined;

/**
 * Web search tool implementation.
 *
 * Supports the configured web model role chain with automatic fallback.
 */
export class WebSearchTool implements AgentTool<typeof webSearchSchema, SearchResultDetails> {
	readonly name = "web_search";
	readonly approval = "read" as const;
	readonly label = "Web Search";
	readonly parameters = webSearchSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Search the web for up-to-date information";

	#session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	/** Advertises X search operators when xAI credentials existed at the process's first read. */
	get description(): string {
		const modelRegistry = this.#session.modelRegistry;
		if (!modelRegistry) return plainDescription;
		registryDescription ??= prompt.render(webSearchDescription, { xSearch: xSearchAvailable(modelRegistry) });
		return registryDescription;
	}

	async execute(
		_toolCallId: string,
		params: SearchToolParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SearchResultDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SearchResultDetails>> {
		const authStorage = this.#session.authStorage ?? (await discoverAuthStorage());
		const sessionId = this.#session.getSessionId?.() ?? undefined;
		return executeSearch(_toolCallId, params, {
			authStorage,
			modelRegistry: this.#session.modelRegistry,
			sessionId,
			sessionModel: this.#session.getActiveModel?.(),
			sessionSearchState: this.#session.getWebSearchSessionState?.(),
			signal,
		});
	}
}

/** Web search tool as CustomTool for consumers embedding the custom-tool API. */
export const webSearchCustomTool: CustomTool<typeof webSearchSchema, SearchResultDetails> = {
	name: "web_search",
	label: "Web Search",
	description: plainDescription,
	parameters: webSearchSchema,

	approval: "read",
	async execute(
		toolCallId: string,
		params: SearchToolParams,
		_onUpdate,
		ctx: CustomToolContext,
		signal?: AbortSignal,
	) {
		const authStorage = ctx.modelRegistry?.authStorage ?? (await discoverAuthStorage());
		const sessionId = ctx.sessionManager.getSessionId();
		return executeSearch(toolCallId, params, {
			authStorage,
			modelRegistry: ctx.modelRegistry,
			sessionId,
			sessionModel: ctx.model,
			signal,
		});
	},
};

export function getSearchTools(): CustomTool<typeof webSearchSchema, SearchResultDetails>[] {
	return [webSearchCustomTool];
}

export { getSearchProvider } from "./provider";
export type { SearchProviderId as SearchProvider, SearchResponse } from "./types";
