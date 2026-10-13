/**
 * Markdown-aware chunker for the web_search RAG pipeline.
 *
 * Documents split at ATX headings: the heading line becomes the section title
 * and is prepended to every window of that section (consecutive headings keep
 * only the deepest as title; shallower ones ride along in the body). Within a
 * section, paragraphs (blank-line separated) merge into token-budgeted
 * windows; a paragraph too big for one window re-splits on sentence
 * boundaries; a fenced code block is atomic — it never straddles a window nor
 * gets cut in half, and an oversized block becomes its own chunk even when it
 * busts the budget. Adjacent windows share a small tail overlap so retrieval
 * can match text straddling a boundary without spending chunk indices on it.
 *
 * Token counts are estimates (`ceil(chars / 4)`): cheap, and close enough for
 * budgeting — embeddings are insensitive to small over/undershoots.
 */

export interface RagChunk {
	/** Position of this chunk within its document, assigned in output order. */
	index: number;
	/** Heading line the chunk's section started with, verbatim (e.g. `"## Setup"`). */
	title?: string;
	/** Window body, prefixed with the section title line when the section has one. */
	text: string;
}

export interface ChunkDocumentOptions {
	/** Window budget in estimated tokens (body only; title and overlap sit on top). */
	maxTokens?: number;
	/** Tail overlap between adjacent windows in estimated tokens. */
	overlapTokens?: number;
}

const DEFAULT_MAX_TOKENS = 800;
const DEFAULT_OVERLAP_TOKENS = 120;

/** ATX heading outside a code fence: 1-6 `#` followed by a space or end of line. */
const HEADING_PATTERN = /^#{1,6}(?:\s|$)/;
/** Opening or closing fence line (indented fences allowed, per CommonMark). */
const FENCE_PATTERN = /^\s*```/;
/**
 * Sentence boundary: after a CJK terminator (unless another terminator
 * immediately follows, so "！！" stays together), or after a Latin terminator
 * when whitespace follows (so "3.14" stays intact). Zero-width, so the pieces
 * concatenate back to the original text exactly.
 */
const SENTENCE_BOUNDARY = /(?<=[。！？])(?![。！？])|(?<=[.!?])(?=\s)/;

interface Segment {
	text: string;
	/** Fenced code block: never sentence-split, kept whole even over budget. */
	code: boolean;
	/**
	 * Piece of a paragraph that started in an earlier segment: joins with no
	 * separator (the piece still carries its original inter-sentence spacing).
	 */
	continuation: boolean;
}

interface Section {
	title: string | undefined;
	blocks: Segment[];
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function splitSentences(text: string): string[] {
	return text.split(SENTENCE_BOUNDARY).filter(piece => piece.trim() !== "");
}

/** Last-resort slice of a single oversized sentence on character boundaries. */
function hardSplit(text: string, maxChars: number): string[] {
	const pieces: string[] = [];
	for (let start = 0; start < text.length;) {
		let end = Math.min(start + maxChars, text.length);
		// Don't cleave a surrogate pair across pieces.
		const tail = text.charCodeAt(end - 1);
		if (end < text.length && tail >= 0xd800 && tail <= 0xdbff) end -= 1;
		if (end <= start) end = start + 1;
		pieces.push(text.slice(start, end));
		start = end;
	}
	return pieces;
}

/**
 * Split a section's lines into paragraph blocks; a fenced block (from its
 * opening fence to the closing fence or EOF) is one atomic block, blank lines
 * inside included.
 */
function splitBlocks(lines: string[]): Segment[] {
	const segments: Segment[] = [];
	let blockLines: string[] = [];
	let blockIsCode = false;

	const flushBlock = (): void => {
		const isCode = blockIsCode;
		const text = blockLines.join("\n").trim();
		blockLines = [];
		blockIsCode = false;
		if (text === "") return;
		segments.push({ text, code: isCode, continuation: false });
	};

	for (const line of lines) {
		if (blockIsCode) {
			blockLines.push(line);
			if (FENCE_PATTERN.test(line)) flushBlock();
			continue;
		}
		if (FENCE_PATTERN.test(line)) {
			flushBlock();
			blockIsCode = true;
			blockLines.push(line);
			continue;
		}
		if (line.trim() === "") {
			flushBlock();
			continue;
		}
		blockLines.push(line);
	}
	flushBlock();
	return segments;
}

/** Explode paragraphs that cannot fit one window into sentence-level segments. */
function buildSegments(blocks: readonly Segment[], maxTokens: number): Segment[] {
	const segments: Segment[] = [];
	for (const block of blocks) {
		if (block.code || estimateTokens(block.text) <= maxTokens) {
			segments.push(block);
			continue;
		}
		let first = true;
		for (const sentence of splitSentences(block.text)) {
			if (estimateTokens(sentence) <= maxTokens) {
				segments.push({ text: sentence, code: false, continuation: !first });
				first = false;
				continue;
			}
			for (const [i, piece] of hardSplit(sentence, maxTokens * 4).entries()) {
				segments.push({ text: piece, code: false, continuation: !first || i > 0 });
			}
			first = false;
		}
	}
	return segments;
}

/** Greedily batch segments into windows within the token budget. */
function groupSegments(segments: readonly Segment[], maxTokens: number): Segment[][] {
	const windows: Segment[][] = [];
	let current: Segment[] = [];
	let currentTokens = 0;

	const flushWindow = (): void => {
		if (current.length > 0) windows.push(current);
		current = [];
		currentTokens = 0;
	};

	for (const segment of segments) {
		const tokens = estimateTokens(segment.text);
		// Only atomic code blocks get here over budget (oversized sentences were
		// hard-split upstream): give them a window of their own.
		if (tokens > maxTokens) {
			flushWindow();
			windows.push([segment]);
			continue;
		}
		if (currentTokens + tokens > maxTokens) flushWindow();
		current.push(segment);
		currentTokens += tokens;
	}
	flushWindow();
	return windows;
}

/** Concatenate segments; sentence pieces rejoin exactly (the split is zero-width). */
function joinSegments(segments: readonly Segment[]): string {
	let text = "";
	for (const segment of segments) {
		if (text === "") {
			text = segment.continuation ? segment.text.replace(/^\s+/, "") : segment.text;
			continue;
		}
		text += segment.continuation ? segment.text : `\n\n${segment.text}`;
	}
	return text;
}

/**
 * Tail of a previous window to carry over, within the overlap budget. A
 * trailing segment bigger than the budget (typically an atomic code block) is
 * never duplicated: overlap stays empty rather than exceeding the budget.
 */
function overlapTail(window: readonly Segment[], overlapTokens: number): string {
	let total = 0;
	let start = window.length;
	for (let i = window.length - 1; i >= 0; i -= 1) {
		const tokens = estimateTokens(window[i]!.text);
		if (total + tokens > overlapTokens) break;
		total += tokens;
		start = i;
	}
	if (start >= window.length) return "";
	return joinSegments(window.slice(start));
}

function splitSections(text: string): Section[] {
	const lines = text.split(/\r?\n/);
	const sections: Section[] = [];
	let pendingHeadings: string[] = [];
	let bodyLines: string[] = [];
	let inCode = false;

	const hasBody = (): boolean => bodyLines.some(line => line.trim() !== "");

	const flush = (): void => {
		if (pendingHeadings.length === 0 && !hasBody()) return;
		if (hasBody()) {
			const blocks: Segment[] = [];
			// A run of consecutive headings keeps only the deepest as the title;
			// shallower ones merge into the body so their context is not lost.
			for (const heading of pendingHeadings.slice(0, -1)) {
				blocks.push({ text: heading, code: false, continuation: false });
			}
			blocks.push(...splitBlocks(bodyLines));
			sections.push({ title: pendingHeadings.at(-1), blocks });
		}
		pendingHeadings = [];
		bodyLines = [];
	};

	for (const line of lines) {
		if (inCode) {
			bodyLines.push(line);
			if (FENCE_PATTERN.test(line)) inCode = false;
			continue;
		}
		if (FENCE_PATTERN.test(line)) {
			inCode = true;
			bodyLines.push(line);
			continue;
		}
		if (HEADING_PATTERN.test(line)) {
			if (hasBody()) {
				flush();
				pendingHeadings = [line];
			} else {
				pendingHeadings.push(line);
			}
			continue;
		}
		bodyLines.push(line);
	}
	flush();
	return sections;
}

export function chunkDocument(text: string, opts?: ChunkDocumentOptions): RagChunk[] {
	const maxTokens = Math.max(1, opts?.maxTokens ?? DEFAULT_MAX_TOKENS);
	// An overlap at or above the window size would duplicate more than it adds.
	const overlapTokens = Math.max(0, Math.min(opts?.overlapTokens ?? DEFAULT_OVERLAP_TOKENS, maxTokens));
	if (text.trim() === "") return [];

	const chunks: RagChunk[] = [];
	for (const section of splitSections(text)) {
		if (section.blocks.length === 0) continue;
		const windows = groupSegments(buildSegments(section.blocks, maxTokens), maxTokens);
		for (let i = 0; i < windows.length; i += 1) {
			const parts: string[] = [];
			if (section.title !== undefined) parts.push(section.title);
			if (i > 0) {
				const overlap = overlapTail(windows[i - 1]!, overlapTokens);
				if (overlap !== "") parts.push(overlap);
			}
			parts.push(joinSegments(windows[i]!));
			const chunk: RagChunk = { index: chunks.length, text: parts.join("\n\n") };
			if (section.title !== undefined) chunk.title = section.title;
			chunks.push(chunk);
		}
	}
	return chunks;
}
