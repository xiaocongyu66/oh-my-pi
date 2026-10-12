import { describe, expect, it } from "bun:test";

import { judgeAnswer, parseJudgeReply } from "../../src/evolution/judge";
import type { ModelTransport } from "../../src/evolution/judge";
import { computeScore } from "../../src/evolution/scoring";
import { conditionScore, rolloutSystemPrompt, runCondition, scoreDeltas } from "../../src/evolution/rollout";
import type { Rollout, TrainingTask } from "../../src/evolution/types";

const task: TrainingTask = {
	id: "s#1",
	prompt: "refactor the module",
	topic: "refactor+module",
	sourceSession: "s",
	trajectoryDigest: "read,edit",
};

function scriptedModel(replies: string[]): ModelTransport {
	let i = 0;
	return async () => {
		const r = replies[Math.min(i, replies.length - 1)] as string;
		i++;
		return r;
	};
}

describe("judge", () => {
	it("parses pass/quality/rationale, clamping quality to 0..1", () => {
		expect(parseJudgeReply('{"pass": true, "quality": 0.75, "rationale": "ok"}')).toEqual({
			pass: true,
			quality: 0.75,
			rationale: "ok",
		});
		expect(parseJudgeReply('noise {"pass": false, "quality": 2, "rationale": "x"} noise')?.quality).toBe(1);
		expect(parseJudgeReply('{"pass": "yes", "quality": 0.5}')).toBeUndefined();
		expect(parseJudgeReply('{"quality": 0.5}')).toBeUndefined();
		expect(parseJudgeReply("no json")).toBeUndefined();
	});

	it("retries once on malformed output, then abstains; abstained never scores", async () => {
		const score = await judgeAnswer({
			transport: scriptedModel(["garbage", '{"pass": false, "quality": 0.3, "rationale": "weak"}']),
			model: "j",
			task,
			answer: "a",
		});
		expect(score).toEqual({ taskId: "s#1", pass: false, quality: 0.3, abstained: false, rationale: "weak" });

		const abstain = await judgeAnswer({
			transport: scriptedModel(["garbage", "still garbage", '{"pass": true, "quality": 0.9}']),
			model: "j",
			task,
			answer: "a",
		});
		expect(abstain.abstained).toBe(true);
		expect(abstain.quality).toBeUndefined();
		expect(abstain.pass).toBeUndefined();
	});

	it("computeScore: hard accuracy + soft mean, abstentions excluded; n=0 undecidable", () => {
		const s = (pass: boolean | undefined, quality: number | undefined, abstained = false) => ({
			taskId: "t",
			pass,
			quality,
			abstained,
			rationale: "",
		});
		expect(computeScore([s(true, 0.4), s(false, 0.6), s(undefined, undefined, true)])).toEqual({
			hard: 0.5,
			soft: 0.5,
			n: 2,
		});
		expect(computeScore([s(undefined, undefined, true)]).n).toBe(0);
	});
});

describe("rollout L1", () => {
	const rollout = (
		taskId: string,
		pass: boolean | undefined,
		quality: number | undefined,
		abstained = false,
	): Rollout => ({
		taskId,
		skillVersion: "v",
		answer: "a",
		score: { taskId, pass, quality, abstained, rationale: "" },
	});

	it("no-skill vs skill system prompts", () => {
		expect(rolloutSystemPrompt(undefined)).toBe("You are completing a software task.");
		expect(rolloutSystemPrompt("DO X")).toContain("<skill>");
		expect(rolloutSystemPrompt("DO X")).toContain("DO X");
	});

	it("runCondition answers then judges per task, sequentially", async () => {
		const seen: string[] = [];
		const target: ModelTransport = async req => {
			seen.push(`answer:${req.system.includes("<skill>") ? "skill" : "none"}`);
			return "final answer";
		};
		const judge: ModelTransport = async () => '{"pass": true, "quality": 0.8, "rationale": "good"}';
		const tasks = [task, { ...task, id: "s#2" }];
		const rollouts = await runCondition(tasks, "SKILL", "v1", {
			target,
			targetModel: "t",
			judge,
			judgeModel: "j",
		});
		expect(rollouts.map(r => r.taskId)).toEqual(["s#1", "s#2"]);
		expect(rollouts.every(r => r.score.quality === 0.8)).toBe(true);
		expect(seen).toEqual(["answer:skill", "answer:skill"]);
		expect(conditionScore(rollouts)).toEqual({ hard: 1, soft: 0.8, n: 2 });
	});

	it("scoreDeltas aligns candidate to baseline; abstentions yield undefined", () => {
		const baseline = [rollout("a", true, 0.4), rollout("b", true, 0.5)];
		const candidate = [rollout("a", true, 0.7), rollout("b", undefined, undefined, true)];
		const deltas = scoreDeltas(baseline, candidate);
		expect(deltas.get("a")).toBeCloseTo(0.3);
		expect(deltas.get("b")).toBeUndefined();
	});
});
