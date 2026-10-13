# web_index

> Fetch a web page and index it into the RAG store (chunked, embedded) so it can be recalled later with `web_recall`.

## Source
- Entry: `packages/coding-agent/src/rag/web-index.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/web-index.md`
- Key collaborators:
  - `packages/coding-agent/src/rag/chunker.ts` — markdown-aware section chunking (`chunkDocument`).
  - `packages/coding-agent/src/rag/store.ts` — bun:sqlite chunk/vector storage (`replaceChunks`).
  - `packages/coding-agent/src/rag/embeddings.ts` — embedder resolution and test injection (`getRagEmbedder`).
  - `packages/coding-agent/src/tools/fetch.ts` — production page fetcher (`fetchReadUrl`); the constructor accepts an injectable fetcher for tests.
  - `packages/coding-agent/src/web/search/cache.ts` — shared web-cache database connection (`openWebCacheDb`).

## Availability and approval

- Created only when `web_search.enabled` and `web_search.rag.enabled` are both `true` (Settings → Tools).
- Approval tier is `read`: the page fetch is read-like; the index write goes to the global web-cache database (`~/.omp/cache/web-cache.db`), not the workspace.
- Embedding uses the configured RAG embedder (local fastembed worker or the configured API endpoint). Without an embedder or without the cache database the call fails honestly with a partial-count reason — nothing is stored, so the page will not be silently unsearchable later.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | `string` | Yes | Page to fetch and index. |
| `namespace` | `string` | No | Isolation bucket for the indexed chunks; defaults to `"web"`. |
| `max_chunks` | `number` | No | Cap on stored chunks; chunks beyond the cap are dropped. |

## Behavior

- The page is fetched and rendered to markdown, split into title-aware chunks, embedded with the active backend, and stored under `(namespace, url)`. Re-indexing the same URL atomically replaces its previous chunks.
- Success output: `Indexed N chunks (X chars) from {url} into namespace "{ns}" (model {model}, dim {dim})`, with matching details for the TUI.
