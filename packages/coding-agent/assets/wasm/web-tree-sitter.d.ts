/**
 * Minimal type surface for the vendored web-tree-sitter loader bundle
 * (`web-tree-sitter.js`, web-tree-sitter 0.25.10). Only the API used by
 * `src/security/bash-ast.ts` is declared; see the README.md next to the
 * vendored assets for provenance.
 */

export declare class Node {
	/** Node type name (named grammar node, or the literal text for anonymous tokens). */
	readonly type: string;
	/** Source text covered by this node. */
	readonly text: string;
	readonly childCount: number;
	readonly children: Node[];
	child(index: number): Node | null;
	/** Field name for the child at `index`, or null when it is unfielded. */
	fieldNameForChild(index: number): string | null;
	/** False for anonymous tokens (operators, punctuation). */
	readonly isNamed: boolean;
}

export declare class Tree {
	readonly rootNode: Node;
	/** Free the WASM-side tree memory. */
	delete(): void;
}

export declare class Language {
	static load(input: string | URL | Uint8Array | ArrayBuffer): Promise<Language>;
}

export declare class Parser {
	constructor();
	/** Load the tree-sitter core WASM. `locateFile` maps wasm file names to URLs/paths. */
	static init(moduleOptions?: { locateFile?: (path: string, prefix: string) => string }): Promise<void>;
	setLanguage(language: Language): void;
	parse(input: string, oldTree?: Tree): Tree;
}
