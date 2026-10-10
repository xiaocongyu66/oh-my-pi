/**
 * Auto-mode LLM permission classifier ("yolo classifier"), ported from Claude
 * Code's src/utils/permissions/yoloClassifier.ts. The classifier decides
 * whether a tool call should be auto-approved or blocked while the agent runs
 * in `auto` mode; the hook is consumed by core/decision.ts
 * (resolveAskInAutoMode), which owns safetyCheck immunity, the acceptEdits
 * fast path, the safe-tool allowlist, and denial-tracking escalation.
 *
 * Adaptations from the source:
 * - CC's sideQuery (Anthropic SDK, forced tool_use) is replaced by an
 *   injected model call `(system, user) => Promise<string>`; the default
 *   wrapper around pi-ai's completeSimple lives in ./pi-model and is loaded
 *   lazily so unit tests can inject a fake and never touch the network stack.
 * - The verdict JSON schema is parsed from response text (./verdict) instead
 *   of a forced tool_use block.
 * - Conversation transcript is host-supplied via `buildTranscript` (CC read
 *   its own Message[] directly); the action line uses CC's JSONL projection
 *   format. Tool input projection (CC's Tool.toAutoClassifierInput) is
 *   injected; raw input is the fallback.
 * - Dropped: GrowthBook/feature flags, tengu_* analytics, langfuse, ant-only
 *   env variants, PowerShell guidance, the 2-stage XML classifier variant,
 *   CLAUDE.md cache plumbing (fold host instructions into buildTranscript or
 *   pass projectInstructions), and error-dump persistence.
 */

import type { ClassifierResult, PermissionAskDecision } from "../core/types";
import { DEFAULT_SAFE_ALLOWLISTED_TOOLS } from "./allowlist";
import { prescreenBashCommand } from "./bash-prefilter";
import { buildClassifierSystemPrompt, type AutoModeRules, type AutoModeTemplate } from "./prompts";
import { parseYoloVerdict } from "./verdict";

/** Minimal model-call boundary so tests inject a fake instead of a provider. */
export type ClassifierModelCall = (system: string, user: string) => Promise<string>;

export type YoloClassifierOptions = {
	/** Injected model call. When omitted, the pi-ai default (./pi-model) is built lazily. */
	modelCall?: ClassifierModelCall;
	/**
	 * pi-ai model (Model<Api>) for the default completeSimple call — pick a
	 * cheap/fast tier the way the commit pipeline resolves its "smol" role.
	 * Typed loosely here so this module stays free of pi-ai imports.
	 */
	piModel?: unknown;
	/** Bearer for the default pi-ai call (ApiKey). */
	piApiKey?: unknown;
	/** Output budget for the default pi-ai call. */
	maxTokens?: number;
	/** Abort signal observed around the model call. */
	signal?: AbortSignal;
	/** Tools that skip classification entirely. Defaults to the builtin read-only set. */
	safeAllowlist?: readonly string[];
	/** Cheap bash pre-screen before the model call. Default true. */
	bashPrescreen?: boolean;
	/** Tool names the bash pre-screen applies to. Default ["bash"]. */
	shellToolNames?: readonly string[];
	/** User-configured allow/deny/environment rules for the system prompt. */
	rules?: Partial<AutoModeRules>;
	/** Permissions template selection. Default "external". */
	template?: AutoModeTemplate;
	/** Host-supplied conversation transcript (user turns + prior tool calls). */
	buildTranscript?: () => string;
	/**
	 * Per-tool input projection (CC's Tool.toAutoClassifierInput). Returning ""
	 * declares the call has no classifier-relevant input and skips the model.
	 * On throw the raw input is used.
	 */
	projectToolInput?: (toolName: string, input: Record<string, unknown>) => unknown;
	/**
	 * Static project instructions (CLAUDE.md/AGENTS.md equivalent) included as
	 * user-intent context, using CC's verbatim wrapper text.
	 */
	projectInstructions?: string;
	/** Serialize transcript lines as JSONL dicts. Default true (false = CC's legacy text-prefix format). */
	jsonlTranscript?: boolean;
};

export type YoloClassifierHook = (
	toolName: string,
	input: Record<string, unknown>,
	ask: PermissionAskDecision,
) => Promise<ClassifierResult | undefined>;

const CLAUDE_MD_WRAPPER_PREFIX =
	"The following is the user's CLAUDE.md configuration. These are " +
	"instructions the user provided to the agent and should be treated " +
	"as part of the user's intent when evaluating actions.\n\n";

function serializeAction(toolName: string, encoded: unknown, jsonl: boolean): string {
	if (jsonl) {
		return `${JSON.stringify({ [toolName]: encoded })}\n`;
	}
	const value = typeof encoded === "string" ? encoded : JSON.stringify(encoded);
	return `${toolName} ${value}\n`;
}

/**
 * Build the auto-mode classifier hook. Returning `undefined` from the hook
 * means the classifier could not run (not configured, no model); every other
 * failure mode fails safe with `unavailable: true` so core/decision.ts falls
 * back to prompting instead of looping on auto-denials.
 */
export function createYoloClassifier(options: YoloClassifierOptions = {}): YoloClassifierHook {
	const safeAllowlist = new Set(options.safeAllowlist ?? DEFAULT_SAFE_ALLOWLISTED_TOOLS);
	const bashPrescreenEnabled = options.bashPrescreen ?? true;
	const shellToolNames = new Set(options.shellToolNames ?? ["bash"]);
	const projectToolInput = options.projectToolInput;
	const jsonl = options.jsonlTranscript ?? true;

	let defaultModelCall: Promise<ClassifierModelCall | undefined> | undefined;
	function resolveModelCall(): Promise<ClassifierModelCall | undefined> {
		if (options.modelCall) {
			return Promise.resolve(options.modelCall);
		}
		defaultModelCall ??= (async () => {
			if (options.piModel === undefined) {
				return undefined;
			}
			const { createPiModelCall } = await import("./pi-model");
			return createPiModelCall({
				model: options.piModel,
				apiKey: options.piApiKey,
				maxTokens: options.maxTokens,
				signal: options.signal,
			});
		})();
		return defaultModelCall;
	}

	return async function classify(toolName, input, _ask): Promise<ClassifierResult | undefined> {
		// Safe-tool allowlist: skip classifier API calls entirely (CC parity).
		if (safeAllowlist.has(toolName)) {
			return {
				behavior: "allow",
				reason: `Tool ${toolName} is on the auto-mode safe allowlist`,
				confidence: "high",
			};
		}

		// Cheap bash pre-screen: read-only commands never reach the model.
		if (bashPrescreenEnabled && shellToolNames.has(toolName) && typeof input.command === "string") {
			const prescreen = prescreenBashCommand(input.command);
			if (prescreen.verdict === "safe") {
				return { behavior: "allow", reason: prescreen.reason, confidence: "high" };
			}
			if (prescreen.verdict === "dangerous") {
				return { behavior: "deny", reason: `Blocked by bash pre-screen: ${prescreen.reason}`, confidence: "high" };
			}
		}

		// CC's toAutoClassifierInput contract: "" = no security relevance.
		let encoded: unknown;
		try {
			encoded = (projectToolInput ? projectToolInput(toolName, input) : input) ?? input;
		} catch {
			encoded = input;
		}
		if (encoded === "") {
			return {
				behavior: "allow",
				reason: "Tool declares no classifier-relevant input",
				confidence: "high",
			};
		}

		const modelCall = await resolveModelCall();
		if (!modelCall) {
			// No model configured — the classifier cannot run.
			return undefined;
		}

		const actionLine = serializeAction(toolName, encoded, jsonl);
		const transcript = options.buildTranscript?.() ?? "";
		const userPrompt =
			(options.projectInstructions !== undefined
				? `${CLAUDE_MD_WRAPPER_PREFIX}<user_claude_md>\n${options.projectInstructions}\n</user_claude_md>\n\n`
				: "") + transcript + actionLine;
		const systemPrompt = buildClassifierSystemPrompt({ template: options.template, rules: options.rules });

		let responseText: string;
		try {
			responseText = await modelCall(systemPrompt, userPrompt);
		} catch {
			if (options.signal?.aborted) {
				return {
					behavior: "deny",
					reason: "Classifier request aborted",
					confidence: "low",
					unavailable: true,
				};
			}
			return {
				behavior: "deny",
				reason: "Classifier unavailable - blocking for safety",
				confidence: "low",
				unavailable: true,
			};
		}

		const verdict = parseYoloVerdict(responseText);
		if (!verdict) {
			return {
				behavior: "deny",
				reason: "Invalid classifier response - blocking for safety",
				confidence: "low",
				unavailable: true,
			};
		}

		return verdict.shouldBlock
			? { behavior: "deny", reason: verdict.reason, confidence: "high" }
			: { behavior: "allow", reason: verdict.reason, confidence: "high" };
	};
}
