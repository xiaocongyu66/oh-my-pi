/**
 * Multimodal image parsing for web_search image results.
 *
 * When the session enables multimodal parsing (`/search` panel), image-modality
 * results are handed to the user-selected vision model, which returns a short
 * description appended to the snippet. The model call is best-effort by
 * contract: any failure (fetch, credential, provider error, abort) resolves to
 * `undefined` and the source passes through untouched rather than delaying or
 * failing the search.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { completeSimple } from "@oh-my-pi/pi-ai";
import imageDescribePrompt from "../../prompts/system/web-search-image-describe.md" with { type: "text" };
import type { SearchSource } from "./types";

/** Refuses to buffer more than this many image bytes (base64-inflated payloads hit provider limits). */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** Description cap so a chatty vision model cannot bloat the digest. */
const MAX_DESCRIPTION_CHARS = 240;

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".avif"]);

/** Cheap URL-shape probe: image-modality results point at image files. */
export function isImageLikeUrl(url: string): boolean {
	try {
		const path = new URL(url).pathname.toLowerCase();
		const dot = path.lastIndexOf(".");
		if (dot === -1) return false;
		return IMAGE_EXTENSIONS.has(path.slice(dot));
	} catch {
		return false;
	}
}

/** Extract the trimmed one-line description from a vision-model reply. */
export function extractImageDescription(text: string | undefined): string | undefined {
	const line = text
		?.split(/\r?\n/)
		.map(l => l.trim())
		.find(l => l.length > 0);
	if (!line) return undefined;
	return line.length > MAX_DESCRIPTION_CHARS ? `${line.slice(0, MAX_DESCRIPTION_CHARS - 1)}…` : line;
}

/** Concatenate the text blocks of an assistant reply (ignoring thinking/tool blocks). */
export function assistantText(message: { content: unknown }): string {
	if (!Array.isArray(message.content)) return "";
	const parts: string[] = [];
	for (const block of message.content) {
		if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
			const text = (block as { text?: unknown }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.join("\n");
}

export interface ImageDescriberContext {
	model: Model<Api>;
	/** Bearer credential for the model's provider; undefined callers skip describing. */
	apiKey: string | undefined;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Injectable transport (tests); defaults to global fetch. */
	fetch?: typeof fetch;
}

async function fetchImageBase64(
	imageUrl: string,
	fetchImpl: typeof fetch,
	signal: AbortSignal | undefined,
): Promise<{ data: string; mimeType: string } | undefined> {
	const response = await fetchImpl(imageUrl, { signal, redirect: "follow" });
	if (!response.ok) return undefined;
	const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
	if (mimeType && !mimeType.startsWith("image/")) return undefined;
	const buffer = await response.arrayBuffer();
	if (buffer.byteLength === 0 || buffer.byteLength > MAX_IMAGE_BYTES) return undefined;
	return {
		data: Buffer.from(buffer).toString("base64"),
		mimeType: mimeType || "image/jpeg",
	};
}

/**
 * Build a describer bound to one vision model. Fetches the image bytes and
 * asks the model for a single-sentence description; every failure path
 * resolves `undefined` (the caller's contract is "best effort, never block").
 */
export function createImageDescriber(
	context: ImageDescriberContext,
): (imageUrl: string) => Promise<string | undefined> {
	return async (imageUrl: string): Promise<string | undefined> => {
		if (!context.apiKey) return undefined;
		const fetchImpl = context.fetch ?? fetch;
		const timeoutSignal = AbortSignal.timeout(context.timeoutMs ?? 20_000);
		const signal = context.signal ? AbortSignal.any([context.signal, timeoutSignal]) : timeoutSignal;
		const image = await fetchImageBase64(imageUrl, fetchImpl, signal);
		if (!image) return undefined;
		const response = await completeSimple(
			context.model,
			{
				systemPrompt: [imageDescribePrompt.trim()],
				messages: [
					{
						role: "user",
						timestamp: Date.now(),
						content: [
							{ type: "text", text: "Describe this image in one sentence." },
							{ type: "image", data: image.data, mimeType: image.mimeType },
						],
					},
				],
			},
			{ apiKey: context.apiKey, maxTokens: 128, signal },
		);
		if (response.stopReason === "error" || response.stopReason === "aborted") return undefined;
		return extractImageDescription(assistantText(response));
	};
}

/**
 * Append `[image: …]` descriptions to every image-like source. Runs the
 * describer over the first `limit` candidates in parallel; sources whose
 * description fails or comes back empty keep their original snippet.
 */
export async function augmentSourcesWithImageDescriptions(
	sources: SearchSource[],
	describe: (imageUrl: string) => Promise<string | undefined>,
	limit = 8,
): Promise<SearchSource[]> {
	const candidates = sources.filter(source => isImageLikeUrl(source.url)).slice(0, limit);
	if (candidates.length === 0) return sources;
	const described = await Promise.all(
		candidates.map(async candidate => {
			try {
				return await describe(candidate.url);
			} catch {
				return undefined;
			}
		}),
	);
	const byUrl = new Map<string, string>();
	for (const [index, candidate] of candidates.entries()) {
		const description = described[index];
		if (description) byUrl.set(candidate.url, description);
	}
	if (byUrl.size === 0) return sources;
	return sources.map(source => {
		const description = byUrl.get(source.url);
		if (!description) return source;
		const note = `[image: ${description}]`;
		return { ...source, snippet: source.snippet ? `${source.snippet} ${note}` : note };
	});
}
