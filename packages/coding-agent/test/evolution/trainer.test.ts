import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { EvolutionStorage } from "../../src/evolution/storage";
import { skillVersion } from "../../src/evolution/storage";
import { trainSkill, DEFAULT_TRAIN_CONFIG } from "../../src/evolution/trainer";
import type { ModelTransport } from "../../src/evolution/judge";
import type { TrainingTask } from "../../src/evolution/types";

const task = (id: string): TrainingTask => ({
	id,
	prompt: `task ${id}`,
	topic: "t",
	sourceSession: "s",
	trajectoryDigest: "read",
});

const SPLIT = {
	train: [task("a1"), task("a2"), task("a3"), task("a4")],
	heldout: [task("h1"), task("h2")],
};

/** Target model: answers carry a marker the judge grades. Under the OPTIMIZED
 *  skill (contains "ALWAYS verify") it answers well; under the seed skill it
 *  answers poorly — drives reflect → propose → accept. */
function makeTarget(): ModelTransport {
	return async req =>
		req.system.includes("ALWAYS verify")
			? "ANSWER_WITH_SKILL: completed the task correctly and efficiently"
			: "ANSWER_BASE: tried but left the task incomplete";
}

/** Judge: grade by the answer marker embedded in the prompt. */
function makeJudge(): ModelTransport {
	return async req => {
		if (req.prompt.includes("ANSWER_WITH_SKILL")) return '{"pass": true, "quality": 0.9, "rationale": "solid"}';
		return '{"pass": false, "quality": 0.2, "rationale": "incomplete"}';
	};
}

const EDIT_JSON = JSON.stringify({
	reasoning: "add concrete guidance",
	edits: [
		{
			op: "append",
			target: "",
			content: "## Verification\nALWAYS verify the result before answering.",
			why: "answers lack verification",
		},
	],
});

function makeOptimizer(
	firstReply: string,
	laterReply = '{"reasoning": "", "edits": []}',
): { transport: ModelTransport; calls: () => number } {
	let calls = 0;
	return {
		calls: () => calls,
		transport: async () => {
			calls++;
			return calls === 1 ? firstReply : laterReply;
		},
	};
}

interface Fixture {
	storage: EvolutionStorage;
	agentDir: string;
}
async function makeFixture(): Promise<Fixture> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-trainer-"));
	const storage = new EvolutionStorage("demo", agentDir);
	await storage.writeSkill("# Skill\nBase guidance.");
	await storage.writeSplit(SPLIT);
	return { storage, agentDir };
}

describe("trainer (SkillOpt main loop, scripted models)", () => {
	let fixture: Fixture;
	beforeEach(async () => {
		fixture = await makeFixture();
	});
	afterEach(async () => {
		await fs.rm(fixture.agentDir, { recursive: true, force: true });
	});

	it("gate accept path: candidate beats baseline → current updated, best_skill.md written", async () => {
		const opt = makeOptimizer(EDIT_JSON);
		const result = await trainSkill({
			storage: fixture.storage,
			target: makeTarget(),
			targetModel: "t",
			judge: makeJudge(),
			judgeModel: "j",
			optimizer: opt.transport,
			optimizerModel: "o",
			config: { maxEpochs: 2, earlyStopSteps: 2 },
		});
		expect(result.reason).toBe("gate-passed");
		const best = await fixture.storage.readBestSkill();
		expect(best).toContain("ALWAYS verify");
		const state = await fixture.storage.readState();
		expect(state?.currentScore).toBeGreaterThan(0);
		expect(state?.bestStep).toBe(1);
		expect(state?.bestVersion).toBe(skillVersion(best as string));
		const skill = await fixture.storage.readSkill();
		expect(skill).toContain("ALWAYS verify");
	});

	it("gate reject path: worse candidate → skill unchanged, rejection buffer grows", async () => {
		// Skill answers well already; optimizer proposes an edit that makes
		// skill answers WORSE (judge grades skill answers low here).
		const badJudge: ModelTransport = async req => {
			if (req.prompt.includes("BAD_EDIT_MARKER")) return '{"pass": false, "quality": 0.05, "rationale": "broken"}';
			if (req.prompt.includes("ANSWER_WITH_SKILL")) return '{"pass": true, "quality": 0.9, "rationale": "solid"}';
			return '{"pass": false, "quality": 0.2, "rationale": "incomplete"}';
		};
		const target: ModelTransport = async req =>
			req.system.includes("<skill>") ? "ANSWER_WITH_SKILL with BAD_EDIT_MARKER" : "ANSWER_BASE incomplete";
		const opt = makeOptimizer(EDIT_JSON);
		const result = await trainSkill({
			storage: fixture.storage,
			target,
			targetModel: "t",
			judge: badJudge,
			judgeModel: "j",
			optimizer: opt.transport,
			optimizerModel: "o",
			config: { maxEpochs: 1 },
		});
		expect(result.steps[0]?.gateAction).toBe("reject");
		const state = await fixture.storage.readState();
		expect(state?.rejectedBuffer.length).toBeGreaterThan(0);
		expect(await fixture.storage.readBestSkill()).toBeUndefined();
		// skill.md unchanged (still the seed content)
		expect(await fixture.storage.readSkill()).toBe("# Skill\nBase guidance.");
	});

	it("skip_no_patches: optimizer silent → skill unchanged, early stop after K", async () => {
		const opt = makeOptimizer('{"reasoning": "", "edits": []}');
		const result = await trainSkill({
			storage: fixture.storage,
			target: makeTarget(),
			targetModel: "t",
			judge: makeJudge(),
			judgeModel: "j",
			optimizer: opt.transport,
			optimizerModel: "o",
			config: { maxEpochs: 10, earlyStopSteps: 2 },
		});
		expect(result.reason).toBe("early-stop");
		expect(result.steps.map(s => s.action)).toEqual(["skip_no_patches", "skip_no_patches"]);
		// skill unchanged; no gate evaluations ran (selection cache untouched
		// beyond baseline → only baseline rollout consumed judge calls)
		expect(await fixture.storage.readBestSkill()).toBeUndefined();
	});

	it("abort mid-run: returns cancelled, state persisted as idle", async () => {
		const controller = new AbortController();
		const opt = makeOptimizer(EDIT_JSON, EDIT_JSON);
		const slowTarget: ModelTransport = async req => {
			controller.abort();
			return req.system.includes("<skill>") ? "ANSWER_WITH_SKILL done" : "ANSWER_BASE incomplete";
		};
		const result = await trainSkill({
			storage: fixture.storage,
			target: slowTarget,
			targetModel: "t",
			judge: makeJudge(),
			judgeModel: "j",
			optimizer: opt.transport,
			optimizerModel: "o",
			config: { maxEpochs: 5 },
			signal: controller.signal,
		});
		expect(result.reason).toBe("cancelled");
		expect((await fixture.storage.readState())?.status).toBe("idle");
	});

	it("no harvested tasks → error result", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-trainer-empty-"));
		try {
			const storage = new EvolutionStorage("empty", agentDir);
			const result = await trainSkill({
				storage,
				target: makeTarget(),
				targetModel: "t",
				judge: makeJudge(),
				judgeModel: "j",
				optimizer: makeOptimizer(EDIT_JSON).transport,
				optimizerModel: "o",
			});
			expect(result.reason).toBe("error");
			expect(result.error).toContain("no eval tasks");
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("L2 gate: promotion only when onL2Verify passes; failure keeps status idle", async () => {
		const opt = makeOptimizer(EDIT_JSON);
		const base = {
			storage: fixture.storage,
			target: makeTarget(),
			targetModel: "t",
			judge: makeJudge(),
			judgeModel: "j",
			optimizer: opt.transport,
			optimizerModel: "o",
			config: { maxEpochs: 1 },
		};
		const ok = await trainSkill({ ...base, onL2Verify: async () => true });
		expect(ok.promoted).toBe(true);
		expect(ok.reason).toBe("promoted");
		expect((await fixture.storage.readState())?.status).toBe("promoted");

		// fresh fixture for the failing path
		await fs.rm(fixture.agentDir, { recursive: true, force: true });
		fixture = await makeFixture();
		const opt2 = makeOptimizer(EDIT_JSON);
		const fail = await trainSkill({
			...base,
			storage: fixture.storage,
			optimizer: opt2.transport,
			onL2Verify: async () => false,
		});
		expect(fail.promoted).toBe(false);
		expect(fail.reason).toBe("l2-failed");
		expect((await fixture.storage.readState())?.status).toBe("idle");
	});

	it("defaults expose the SkillOpt textual learning rate", () => {
		expect(DEFAULT_TRAIN_CONFIG.learningRate).toBeGreaterThan(0);
		expect(DEFAULT_TRAIN_CONFIG.gateMetric).toBe("soft");
	});
});
