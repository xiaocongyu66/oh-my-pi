/**
 * Conversation-transcript serializer for the auto-mode classifier. CC built
 * the transcript from its own Message[] inside yoloClassifier; here the host
 * supplies messages and this module projects them to the same JSONL line
 * format the classifier prompt expects: `{"user": ...}` for user turns,
 * `{"assistant": ...}` for assistant text, and `{<toolName>: <input>}` lines
 * for assistant tool_use blocks (identical to the final action line).
 *
 * Structural typing on purpose: the host message union is wide and several
 * members (tool results, custom notices) carry nothing the classifier may
 * consider, so unrecognized shapes are skipped rather than typed away.
 */

const MAX_MESSAGES = 40;
const MAX_TEXT_CHARS = 500;

type ContentBlock = { type?: string; text?: string; name?: string; input?: unknown };

function blocksOf(content: unknown): ContentBlock[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (Array.isArray(content)) return content as ContentBlock[];
	return [];
}

function clip(text: string): string {
	return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text;
}

function projectMessage(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const { role, content } = message as { role?: unknown; content?: unknown };
	if (role === "user") {
		const text = blocksOf(content)
			.filter(block => block.type === "text" || typeof block.text === "string")
			.map(block => block.text ?? "")
			.join("\n")
			.trim();
		return text ? `${JSON.stringify({ user: clip(text) })}\n` : undefined;
	}
	if (role === "assistant") {
		const lines: string[] = [];
		const text = blocksOf(content)
			.filter(block => block.type === "text")
			.map(block => block.text ?? "")
			.join("\n")
			.trim();
		if (text) lines.push(`${JSON.stringify({ assistant: clip(text) })}\n`);
		for (const block of blocksOf(content)) {
			if (block.type === "tool_use" && typeof block.name === "string") {
				lines.push(`${JSON.stringify({ [block.name]: block.input ?? {} })}\n`);
			}
		}
		return lines.join("") || undefined;
	}
	return undefined;
}

/** Serialize the tail of a conversation into classifier JSONL lines. */
export function serializeTranscript(messages: readonly unknown[], maxMessages = MAX_MESSAGES): string {
	return messages
		.slice(-maxMessages)
		.map(projectMessage)
		.filter((line): line is string => line !== undefined)
		.join("");
}
