# Vendored WASM assets for bash AST parsing

These files are vendored directly (no npm install) and used by
`src/security/bash-ast.ts` to parse bash commands with web-tree-sitter.

| File                    | Source                                                                                                                     | Version                 | License |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------- |
| `web-tree-sitter.js`    | https://cdn.jsdelivr.net/npm/web-tree-sitter@0.25.10/tree-sitter.js                                                        | web-tree-sitter 0.25.10 | MIT     |
| `tree-sitter.wasm`      | https://cdn.jsdelivr.net/npm/web-tree-sitter@0.25.10/tree-sitter.wasm                                                      | web-tree-sitter 0.25.10 | MIT     |
| `tree-sitter-bash.wasm` | https://registry.npmjs.org/tree-sitter-bash/-/tree-sitter-bash-0.25.1.tgz (extracted from `package/tree-sitter-bash.wasm`) | tree-sitter-bash 0.25.1 | MIT     |

Notes:

- The npm registry used here does not serve the scoped
  `@tree-sitter-grammars/tree-sitter-bash` package, so the classic
  `tree-sitter-bash` package (same grammar, MIT licensed) was used instead.
  Its 0.25.1 grammar wasm is ABI-compatible with web-tree-sitter 0.25.x.
- The loader is a plain ESM bundle (no `tree-sitter.wasm` side-load needed;
  it embeds/loads the core module relative to the imported file location).
- Re-vendor by downloading the two files above and replacing them here.
