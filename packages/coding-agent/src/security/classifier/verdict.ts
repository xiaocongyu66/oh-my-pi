/**
 * Verdict parsing for the auto-mode classifier, ported from Claude Code's
 * yoloClassifier tool-use schema (the forced `classify_result` tool with
 * input {thinking, shouldBlock, reason}). pi-ai's completeSimple returns
 * plain text instead of forced tool_use blocks, so the same JSON shape is
 * extracted from the response text.
 */

export type YoloVerdict = {
	/** Brief step-by-step reasoning from the classifier model. */
	thinking: string;
	/** Whether the action should be blocked (true) or allowed (false). */
	shouldBlock: boolean;
	/** Brief explanation of the classification decision. */
	reason: string;
};

const CODE_FENCE_RE = /^```(?:json)?\s*([\s\S]*?)\s*```$/;

/** Extract the outermost JSON object text from a model response, if any. */
function extractJsonObject(text: string): string | null {
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		return null;
	}
	const fenced = CODE_FENCE_RE.exec(trimmed);
	const candidate = fenced ? fenced[1]! : trimmed;
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start === -1 || end <= start) {
		return null;
	}
	return candidate.slice(start, end + 1);
}

/**
 * Parse a classifier verdict from raw model text. Returns null when no
 * well-formed verdict object is present (missing fields or wrong types count
 * as malformed, mirroring CC's strict zod schema).
 */
export function parseYoloVerdict(text: string): YoloVerdict | null {
	const json = extractJsonObject(text);
	if (json === null) {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return null;
	}
	const record = parsed as Record<string, unknown>;
	if (typeof record.thinking !== "string" || typeof record.shouldBlock !== "boolean" || typeof record.reason !== "string") {
		return null;
	}
	return { thinking: record.thinking, shouldBlock: record.shouldBlock, reason: record.reason };
}
