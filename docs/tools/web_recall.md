# web_recall

> Semantic recall over pages previously stored by `web_index`: embeds the query and returns the most similar indexed chunks with scores.

## Source
- Entry: `packages/coding-agent/src/rag/web-recall.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/web-recall.md`
- Key collaborators:
  - `packages/coding-agent/src/rag/store.ts` — chunk listing (`listChunks`) and query-vector cache.
  - `packages/coding-agent/src/rag/embeddings.ts` — embedder resolution (`getRagEmbedder`); the query is embedded with the same backend used at index time.
  - `@oh-my-pi/pi-mnemopi/core/vector-index` — exact KNN (`buildExactVectorIndex` / `searchExactVectorIndex`); scores are cosine similarity (~1 = near-exact).
  - `packages/coding-agent/src/web/search/cache.ts` — shared web-cache database connection.

## Availability and approval

- Created only when `web_search.enabled` and `web_search.rag.enabled` are both `true` (Settings → Tools).
- Approval tier is `read`.
- Rows stored without vectors, or under a differently sized backend, are skipped rather than failing the query; an empty namespace answers with a pointer back to `web_index`.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | `string` | Yes | Natural-language query to match against indexed chunks. |
| `namespace` | `string` | No | Isolation bucket to search; defaults to `"web"`. |
| `limit` | `number` | No | Maximum matches returned; defaults to 6. |

## Behavior

- Each hit is rendered as `[n] {title ?? url}` / url / `score x.xx` / a ~300-character snippet, and mirrored in `details.matches` for the TUI. Output is truncated by the shared output budget.
