/**
 * Tree-sitter bash AST extraction, porting the structure-proof half of Claude
 * Code's BashTool security analysis (its astSubcommands / astRedirects parse).
 *
 * The tokenizer-based surfaces (`tools/shell-tokenize` feeding bash-check and
 * bash-path-validation) are quote-aware but structure-blind: glued redirects,
 * quote desyncs, and comment text can hide or invent redirect targets. The AST
 * parse answers from the real bash grammar instead:
 *
 *   - `subcommands`: text of every `command` node — includes commands inside
 *     pipelines, subshells, command substitutions, and function bodies.
 *   - `redirects`: every `file_redirect` / `heredoc_redirect` /
 *     `herestring_redirect` node as `{ op, target, quoted }`, where `op` is the
 *     operator with its file-descriptor prefix (`>`, `>>`, `2>&`, `&>`, `<<-`,
 *     `<<<`, …) and `target` is the quote-stripped destination text.
 *
 * Grammar node-name notes (tree-sitter-bash 0.25.1): redirects hang off
 * `redirected_statement` (and herestrings off `command`) as nodes named
 * `*_redirect`; the operator itself is an *unnamed* token child whose type is
 * its literal text, the fd prefix lives in a `descriptor`-field child, and the
 * destination in a `destination`-field child (heredoc delimiters are
 * field-less `heredoc_start` children, herestring targets field-less words).
 *
 * The web-tree-sitter loader and both WASM files are vendored under
 * `assets/wasm/` (see the README there) and initialized lazily on first use.
 * Every failure mode — load error, oversized input, parser absence — yields
 * null so callers fall back to the tokenizer path (CC's legacy/shadow mode);
 * nothing here is allowed to throw into the permission path.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser, type Node as WtsNode } from "../../assets/wasm/web-tree-sitter.js";

const WASM_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../assets/wasm");
const BASH_WASM_PATH = path.join(WASM_DIR, "tree-sitter-bash.wasm");

/**
 * CC parity: commands longer than this are not AST-checked; the tokenizer path
 * still runs on them.
 */
export const BASH_AST_MAX_COMMAND_CHARS = 10_000;

/**
 * Traversal bounds for adversarial inputs. The token scan covers anything the
 * walk declines, so bailing is always safe.
 */
const MAX_AST_NODES = 50_000;
const MAX_AST_DEPTH = 128;

/** One redirect extracted from the bash AST. */
export interface BashAstRedirect {
	/** Operator including fd prefix: `>`, `>>`, `2>&`, `&>`, `<<-`, `<<<`, … */
	op: string;
	/** Destination text, outer quotes stripped when fully quoted. */
	target: string;
	/** The destination was quoted (`'…'`/`"…"`) in the source. */
	quoted: boolean;
}

/** Successful extraction result (CC's astSubcommands + astRedirects surface). */
export interface BashAstParse {
	subcommands: string[];
	redirects: BashAstRedirect[];
	available: boolean;
}

interface LoadedParser {
	parser: Parser;
}

let loadPromise: Promise<LoadedParser | null> | undefined;
let loaded: LoadedParser | null = null;

async function loadBashParserOnce(): Promise<LoadedParser | null> {
	try {
		// The loader resolves `tree-sitter.wasm` (tree-sitter core) via
		// `locateFile`; both wasm files sit next to the vendored loader.
		await Parser.init({ locateFile: file => path.join(WASM_DIR, file) });
		const language = await Language.load(new Uint8Array(await Bun.file(BASH_WASM_PATH).arrayBuffer()));
		const parser = new Parser();
		parser.setLanguage(language);
		const loadedParser = { parser };
		loaded = loadedParser;
		return loadedParser;
	} catch {
		// Load failure is permanent for this process: callers keep using the
		// tokenizer path (CC's legacy/shadow mode) without repeated attempts.
		return null;
	}
}

function getParserOnce(): Promise<LoadedParser | null> {
	if (!loadPromise) loadPromise = loadBashParserOnce();
	return loadPromise;
}

/**
 * Warm the lazy tree-sitter singleton. Idempotent; resolves true once the bash
 * parser is usable and false when loading failed (fallback to the tokenizer).
 * The synchronous permission path fires this and then reads the sync snapshot
 * below — early calls fall back until the load lands.
 */
export function ensureBashAstLoaded(): Promise<boolean> {
	return getParserOnce().then(result => result !== null);
}

/**
 * Parse `command` with tree-sitter and extract subcommands and redirects.
 * Returns null when the parser is unavailable (not loaded yet / load failed /
 * input over {@link BASH_AST_MAX_COMMAND_CHARS}); never throws.
 */
export async function parseBashAst(command: string): Promise<BashAstParse | null> {
	if (command.length > BASH_AST_MAX_COMMAND_CHARS) return null;
	const loadedParser = await getParserOnce();
	return loadedParser ? extractBashAst(loadedParser.parser, command) : null;
}

/**
 * Synchronous snapshot for the sync permission path: null unless the singleton
 * has already loaded. Callers must treat null as "use the tokenizer path".
 */
export function parseBashAstSync(command: string): BashAstParse | null {
	if (command.length > BASH_AST_MAX_COMMAND_CHARS) return null;
	return loaded ? extractBashAst(loaded.parser, command) : null;
}

/**
 * True for output redirects (the write side): `>`, `>>`, `>&`, `>|`, `&>`,
 * `&>>`, and their fd-prefixed variants. Input-only operators (`<`, `<<`,
 * `<<-`, `<<<`, `<&`) never write files.
 */
export function isBashAstWriteRedirect(redirect: BashAstRedirect): boolean {
	return redirect.op.includes(">");
}

function extractBashAst(parser: Parser, command: string): BashAstParse | null {
	let tree: ReturnType<Parser["parse"]> | undefined;
	try {
		tree = parser.parse(command);
		const subcommands: string[] = [];
		const redirects: BashAstRedirect[] = [];
		// Explicit stack: adversarial nesting must not be able to blow the JS
		// recursion limit inside the permission path. Children are pushed in
		// reverse so traversal (and extraction order) follows source order.
		const stack: Array<{ node: WtsNode; depth: number }> = [{ node: tree.rootNode, depth: 0 }];
		let visited = 0;
		while (stack.length > 0 && visited < MAX_AST_NODES) {
			const entry = stack.pop();
			if (!entry) break;
			const { node, depth } = entry;
			visited++;
			const type = node.type;
			if (type === "command") {
				subcommands.push(node.text);
			} else if (type === "file_redirect" || type === "heredoc_redirect" || type === "herestring_redirect") {
				const redirect = extractRedirect(node);
				if (redirect) redirects.push(redirect);
			}
			if (depth >= MAX_AST_DEPTH) continue;
			for (let i = node.childCount - 1; i >= 0; i--) {
				const child = node.child(i);
				if (child) stack.push({ node: child, depth: depth + 1 });
			}
		}
		return { subcommands, redirects, available: true };
	} catch {
		// Never throw into the permission path — fall back to the tokenizer.
		return null;
	} finally {
		try {
			tree?.delete();
		} catch {
			// tree already freed
		}
	}
}

/**
 * Extract one `file_redirect` / `heredoc_redirect` / `herestring_redirect`.
 * The operator is the first unnamed child (its text is the operator literal);
 * the fd prefix (if any) is the `descriptor`-field child and the destination
 * the `destination`-field child; heredoc/herestring targets ride field-less
 * named children instead. Returns null only for degenerate nodes without an
 * operator token.
 */
function extractRedirect(node: WtsNode): BashAstRedirect | null {
	let descriptor = "";
	let op = "";
	let target: string | null = null;
	let quoted = false;
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (!child) continue;
		const field = node.fieldNameForChild(i);
		if (field === "descriptor") {
			descriptor = child.text;
			continue;
		}
		if (field === "destination") {
			// Grammar quirk: `2>&1 cat` yields two destination children (the dup
			// target `1` plus the trailing argument word). Bash semantics — and
			// the fd-dup skip — key on the first one.
			if (target === null) {
				target = quoteStrippedTarget(child);
				quoted = isQuotedNode(child);
			}
			continue;
		}
		if (field) continue;
		// `isNamed` is a getter property in web-tree-sitter 0.25.x.
		if (!child.isNamed) {
			if (!op) op = child.text;
			continue;
		}
		// Field-less named children carry heredoc/herestring targets; the
		// heredoc body and end marker are data, not the redirect target.
		if (target !== null || child.type === "heredoc_body" || child.type === "heredoc_end") continue;
		const raw = child.text;
		target = quoteStrippedTarget(child);
		quoted = isQuotedNode(child) || target !== raw;
	}
	if (!op) return null;
	return { op: descriptor + op, target: target ?? "", quoted };
}

function quoteStrippedTarget(node: WtsNode): string {
	const text = node.text;
	return text.length >= 2 && (text.startsWith("'") || text.startsWith('"')) && text.endsWith(text[0])
		? text.slice(1, -1)
		: text;
}

function isQuotedNode(node: WtsNode): boolean {
	return node.type === "string" || node.type === "raw_string";
}
