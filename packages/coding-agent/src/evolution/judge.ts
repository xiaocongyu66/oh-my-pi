/**
 * LLM judge (SkillOpt scoring). Pure parsing/decision logic; the model call is
 * injected as a transport so tests can script verdicts and every production
 * call site goes through the same role-resolution/fallback plumbing (Phase 5).
 *
 * Output shape mirrors SkillOpt's compute_score pair (utils/scoring.py):
 * every verdict carries `pass` (hard exact-match) and `quality` (0..1 soft
 * partial credit), so the gate can run hard/soft/mixed metrics unchanged.
 */
import type { RolloutScore, RubricCriterion, TrainingTask } from "./types";

/** Minimal model transport: one prompt in, raw text out. */
export type ModelTransport = (req: {
	model: string;
	system: string;
	prompt: string;
	signal?: AbortSignal;
}) => Promise<string>;

export const DEFAULT_RUBRIC: RubricCriterion[] = [
	{ name: "task completion", weight: 0.5 },
	{ name: "correctness of approach", weight: 0.3 },
	{ name: "efficiency (no wasted steps)", weight: 0.2 },
];

export function buildJudgePrompt(task: TrainingTask, answer: string, rubric: RubricCriterion[]): string {
	const dims = rubric.map(c => `- ${c.name} (weight ${c.weight})`).join("\n");
	return [
		`You grade one AI-agent answer to a task. Score each rubric dimension 0-10, then reply with STRICT JSON only:`,
		`{"pass": <true|false — did the answer fully accomplish the task>, "quality": <0.0-1.0 partial credit>, "rationale": "<one or two sentences>"}`,
		``,
		`Rubric (weighted):`,
		dims,
		``,
		`Task (from a real session; tool trajectory was: ${task.trajectoryDigest}):`,
		`"""${task.prompt}"""`,
		``,
		`Answer to grade:`,
		`"""${answer.slice(0, 4000)}"""`,
	].join("\n");
}

export const JUDGE_SYSTEM =
	"You are a strict, consistent grader of AI-agent answers. You never inflate scores, you are harsh on answers that claim success without evidence, and you reply with JSON only.";

/**
 * Appended to every evolution system prompt (judge/optimizer/target rollouts):
 * task prompts are harvested verbatim from recorded sessions, so they may
 * carry real credentials. Best-effort guard — the model is told never to
 * reproduce them; redaction at the source remains the real fix.
 */
export const SECRET_HANDLING_DIRECTIVE =
	"The task material may come from recorded sessions and can contain secrets (API keys, tokens, passwords, private URLs). Never copy any secret into your output: if input material contains a credential, refer to it only as [REDACTED].";

interface JudgeRaw {
	pass?: unknown;
	quality?: unknown;
	rationale?: unknown;
}

/** Parse one judge reply. Undefined = malformed (caller retries/abstains). */
export function parseJudgeReply(reply: string): { pass: boolean; quality: number; rationale: string } | undefined {
	const start = reply.indexOf("{");
	const end = reply.lastIndexOf("}");
	if (start === -1 || end <= start) return undefined;
	let raw: JudgeRaw;
	try {
		raw = JSON.parse(reply.slice(start, end + 1)) as JudgeRaw;
	} catch {
		return undefined;
	}
	if (typeof raw.pass !== "boolean") return undefined;
	if (typeof raw.quality !== "number" || !Number.isFinite(raw.quality)) return undefined;
	const quality = Math.min(1, Math.max(0, raw.quality));
	const rationale = typeof raw.rationale === "string" ? raw.rationale.slice(0, 500) : "";
	return { pass: raw.pass, quality, rationale };
}

/**
 * Grade one answer. One repair retry on malformed output; after that the
 * judge ABSTAINS (abstained verdicts never move a gate — SkillOpt keeps
 * validation independent of flaky scoring).
 */
export async function judgeAnswer(opts: {
	transport: ModelTransport;
	model: string;
	task: TrainingTask;
	answer: string;
	rubric?: RubricCriterion[];
	signal?: AbortSignal;
}): Promise<RolloutScore> {
	const rubric = opts.rubric ?? DEFAULT_RUBRIC;
	const prompt = buildJudgePrompt(opts.task, opts.answer, rubric);
	for (let attempt = 0; attempt < 2; attempt++) {
		let reply: string;
		try {
			reply = await opts.transport({ model: opts.model, system: JUDGE_SYSTEM, prompt, signal: opts.signal });
		} catch (err) {
			if (opts.signal?.aborted) throw err;
			continue; // transport failure grades like malformed output
		}
		const parsed = parseJudgeReply(reply);
		if (parsed) {
			return {
				taskId: opts.task.id,
				pass: parsed.pass,
				quality: parsed.quality,
				abstained: false,
				rationale: parsed.rationale,
			};
		}
	}
	return {
		taskId: opts.task.id,
		pass: undefined,
		quality: undefined,
		abstained: true,
		rationale: "judge output unparseable after retry",
	};
}
