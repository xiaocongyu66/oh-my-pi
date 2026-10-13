/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

// Exa
export const cfgExaEnabled = register({
	id: "exa.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Exa",
		description: "Enable the Exa web search provider",
	},
});

export const cfgExaSearchDelayMs = register({
	id: "exa.searchDelayMs",
	type: "number",
	default: 1_000,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Exa Search Delay",
		description: "Minimum delay between Exa web search requests in milliseconds; set 0 to disable pacing",
	},
});

// SearXNG
export const cfgSearxngEndpoint = register({
	id: "searxng.endpoint",
	type: "string",
	default: undefined,
	env: { name: "SEARXNG_ENDPOINT", fallback: "blank" },
	ui: {
		tab: "providers",
		group: "Services",
		label: "SearXNG Endpoint",
		description: "Base URL of a self-hosted SearXNG instance used for web search",
	},
});

export const cfgSearxngToken = register({
	id: "searxng.token",
	type: "string",
	default: undefined,
	env: { name: "SEARXNG_TOKEN", fallback: "blank" },
	credential: true,
});

export const cfgSearxngBasicUsername = register({
	id: "searxng.basicUsername",
	type: "string",
	default: undefined,
	// An empty username/password is a valid RFC 7617 credential, so blank text is kept.
	env: { name: "SEARXNG_BASIC_USERNAME", parse: raw => raw, fallback: true },
});

export const cfgSearxngBasicPassword = register({
	id: "searxng.basicPassword",
	type: "string",
	default: undefined,
	env: { name: "SEARXNG_BASIC_PASSWORD", parse: raw => raw, fallback: true },
	credential: true,
});

export const cfgSearxngCategories = register({ id: "searxng.categories", type: "string", default: undefined });

export const cfgSearxngEngines = register({ id: "searxng.engines", type: "string", default: undefined });

export const cfgSearxngLanguage = register({ id: "searxng.language", type: "string", default: undefined });

export const cfgSearxngSafesearch = register({ id: "searxng.safesearch", type: "number", default: undefined });

// Web-search pipeline settings (`web_search.*`, non-RAG).

export const cfgWebSearchCommonCrawlIndex = register({
	id: "web_search.commonCrawlIndex",
	type: "string",
	default: "CC-MAIN-2025-08",
	ui: {
		tab: "providers",
		group: "Services",
		label: "Common Crawl Index",
		description: "Common Crawl index collection queried by the commoncrawl archive search provider",
	},
});

// RAG over web search results (`web_search.rag.*`). Kept in its own block at
// the end of the file: the search-cache settings land in this same file
// concurrently (#76), and a separate section keeps that merge conflict-free.

export const cfgWebSearchRagEnabled = register({
	id: "web_search.rag.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "providers",
		group: "Services",
		label: "RAG Over Web Search",
		description: "Store fetched pages as embedded chunks and resurface them via vector recall on later searches",
	},
});

export const cfgWebSearchRagEmbedding = register({
	id: "web_search.rag.embedding",
	type: "enum",
	values: ["local", "api", "off"] as const,
	default: "local",
	ui: {
		tab: "providers",
		group: "Services",
		label: "RAG Embedding Backend",
		description:
			"Where RAG chunk embeddings come from: the local fastembed subprocess, an OpenAI-compatible API, or off",
		options: [
			{ value: "local", label: "Local", description: "Embed via the local mnemopi fastembed subprocess" },
			{ value: "api", label: "API", description: "POST to an OpenAI-compatible /embeddings endpoint" },
			{ value: "off", label: "Off", description: "Disable embedding; RAG chunks are stored without vectors" },
		],
	},
});

export const cfgWebSearchRagEmbeddingApiUrl = register({
	id: "web_search.rag.embeddingApiUrl",
	type: "string",
	default: undefined,
	env: { name: "RAG_EMBEDDING_API_URL", fallback: "blank" },
	ui: {
		tab: "providers",
		group: "Services",
		label: "RAG Embedding API URL",
		description:
			"Base URL of an OpenAI-compatible embeddings endpoint used when the RAG embedding backend is API (e.g. https://api.openai.com/v1)",
	},
});

export const cfgWebSearchRagEmbeddingApiKey = register({
	id: "web_search.rag.embeddingApiKey",
	type: "string",
	default: undefined,
	env: { name: "RAG_EMBEDDING_API_KEY", fallback: "blank" },
	credential: true,
});
