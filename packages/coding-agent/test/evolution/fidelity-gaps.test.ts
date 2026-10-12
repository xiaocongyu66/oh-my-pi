import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { computeSemanticDensity } from "../../src/evolution/gate";
import { applyEditWithReport } from "../../src/evolution/optimizer";
import { cosineEditBudget, trainSkill } from "../../src/evolution/trainer";
import { EvolutionStorage, skillVersion } from "../../src/evolution/storage";
import type { ModelTransport } from "../../src/evolution/judge";
import type { EvolutionState, TrainingTask } from "../../src/evolution/types";

describe("fidelity gaps locked by adversarial verification", () => {
	it("semantic density strips only the MARKER of an unclosed block (gate.py:70-72)", () => {
		// "MUST do this. <!-- APPENDIX_START --> junk text" → words
		// [must, do, this, junk, text], one leading word → 0.2 (Python-verified).
		expect(computeSemanticDensity("MUST do this. <!-- APPENDIX_START --> junk text")).toBeCloseTo(0.2);
	});

	it("replace content is a LITERAL: $ sequences never expand (skill.py:132)", () => {
		const out = applyEditWithReport("X alpha", {
			op: "replace",
			target: "X",
			content: "[$&][$'][$`][$'][$1][$$]",
			why: "",
			tokens: 1,
		});
		expect(out.skill).toBe("[$&][$'][$`][$'][$1][$$] alpha");
	});

	it("cosine scheduler: degenerate total stays at max; banker's rounding", () => {
		expect(cosineEditBudget(1, 1, 3, 2)).toBe(3); // total<=1 → max_lr
		expect(cosineEditBudget(5, 10, 3, 2)).toBe(2); // 2.5 → Python round() → 2
		expect(cosineEditBudget(3, 10, 3, 2)).toBe(3); // 2.96 → 3
	});

	describe("trainer cache/resume/final-promote", () => {
		let agentDir: string;
		beforeEach(async () => {
			agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fidelity-"));
		});
		afterEach(async () => {
			await fs.rm(agentDir, { recursive: true, force: true });
		});

		const task = (id: string): TrainingTask => ({
			id,
			prompt: `task ${id}`,
			topic: "t",
			sourceSession: "s",
			trajectoryDigest: "read",
		});

		/** Target answers well under an optimized skill, poorly otherwise. */
		const target: ModelTransport = async req =>
			req.system.includes("ALWAYS verify") ? "ANSWER_WITH_SKILL: completed correctly" : "ANSWER_BASE: incomplete";
		const judge: ModelTransport = async req => {
			if (req.prompt.includes("ANSWER_WITH_SKILL")) return '{"pass": true, "quality": 0.9, "rationale": "good"}';
			return '{"pass": false, "quality": 0.2, "rationale": "bad"}';
		};

		async function seedStorage(skill: string, state?: Partial<EvolutionState>) {
			const storage = new EvolutionStorage("demo", agentDir);
			await storage.writeSkill(skill);
			await storage.writeSplit({ train: [task("a1"), task("a2"), task("a3")], heldout: [task("h1"), task("h2")] });
			if (state) {
				await storage.writeState({
					skill: "demo",
					version: skillVersion(skill),
					bestVersion: skillVersion(skill),
					step: 0,
					bestStep: 0,
					currentScore: -1,
					bestScore: -1,
					rejectedBuffer: [],
					lastRunDate: undefined,
					status: "idle",
					...state,
				});
			}
			return storage;
		}

		it("selection cache reuses hash entries: judge is not re-asked for the same skill", async () => {
			const storage = await seedStorage("# Skill\nSeed.");
			let judgeCalls = 0;
			const countingJudge: ModelTransport = async req => {
				judgeCalls++;
				return judge(req);
			};
			const result = await trainSkill({
				storage,
				target,
				targetModel: "t",
				judge: countingJudge,
				judgeModel: "j",
				optimizer: async () => '{"reasoning":"","edits":[]}',
				optimizerModel: "o",
				config: { maxEpochs: 0 },
			});
			// maxEpochs=0 → no steps; baseline (2 calls) + final re-eval, which
			// MUST hit the selection cache instead of re-asking the judge.
			expect(result.reason).toBe("gate-never-passed");
			expect(judgeCalls).toBe(2);
		});

		it("resume: loop starts at persisted state.step + 1", async () => {
			const storage = await seedStorage("# Skill\nSeed.", { step: 3, currentScore: 0.2, bestScore: 0.2 });
			const result = await trainSkill({
				storage,
				target,
				targetModel: "t",
				judge,
				judgeModel: "j",
				optimizer: async () => '{"reasoning":"","edits":[]}',
				optimizerModel: "o",
				config: { maxEpochs: 4, earlyStopSteps: 99 },
			});
			expect(result.steps.map(s => s.step)).toEqual([4]);
		});

		it("final re-eval promotes the final skill over a stale best (trainer.py:2229-2275)", async () => {
			// skill.md is optimized (0.9 on selection); persisted best is stale at 0.7.
			const storage = await seedStorage("## Verification\nALWAYS verify before answering.", {
				currentScore: 0.5,
				bestScore: 0.7,
				bestStep: 1,
				bestVersion: "stale00000000000",
			});
			const result = await trainSkill({
				storage,
				target,
				targetModel: "t",
				judge,
				judgeModel: "j",
				optimizer: async () => '{"reasoning":"","edits":[]}',
				optimizerModel: "o",
				config: { maxEpochs: 0 },
			});
			expect(result.reason).toBe("gate-passed");
			const best = await storage.readBestSkill();
			expect(best).toContain("ALWAYS verify");
			const state = await storage.readState();
			expect(state?.bestScore).toBeCloseTo(0.9);
			expect(state?.bestVersion).toBe(skillVersion(best as string));
		});
	});
});
