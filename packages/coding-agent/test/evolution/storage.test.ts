import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { EvolutionStorage, getSkillEvolutionDir, skillVersion } from "../../src/evolution/storage";
import type { EvolutionState, LedgerEntry, StepRecord, TrainingTask } from "../../src/evolution/types";

const task = (id: string, topic = "t"): TrainingTask => ({
	id,
	prompt: `prompt ${id}`,
	topic,
	sourceSession: "s.jsonl",
	trajectoryDigest: "digest",
});

const state = (over: Partial<EvolutionState> = {}): EvolutionState => ({
	skill: "demo",
	version: "v0",
	bestVersion: "v0",
	step: 0,
	bestStep: 0,
	currentScore: -1,
	bestScore: -1,
	rejectedBuffer: [],
	lastRunDate: undefined,
	status: "idle",
	...over,
});

describe("evolution storage", () => {
	let agentDir: string;
	beforeEach(async () => {
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-evolution-"));
	});
	afterEach(async () => {
		await fs.rm(agentDir, { recursive: true, force: true });
	});

	it("stores everything under the agent evolution dir, keyed by sanitized slug", async () => {
		const store = new EvolutionStorage("My-Skill", agentDir);
		await store.ensureRoot();
		const expected = path.join(getSkillEvolutionDir("my-skill", agentDir));
		expect(await fs.stat(expected)).toBeTruthy();
	});

	it("rejects path-escaping slugs via managed sanitize", () => {
		expect(() => getSkillEvolutionDir("../evil", agentDir)).toThrow();
	});

	it("skillVersion is content-addressed and stable", () => {
		expect(skillVersion("a")).toBe(skillVersion("a"));
		expect(skillVersion("a")).not.toBe(skillVersion("b"));
		expect(skillVersion("a")).toHaveLength(16);
	});

	it("round-trips skill, state, split, epochs; snapshots candidates", async () => {
		const store = new EvolutionStorage("demo", agentDir);
		expect(await store.readSkill()).toBeUndefined();
		const v = await store.writeSkill("# skill body");
		expect(v).toBe(skillVersion("# skill body"));
		expect(await store.readSkill()).toBe("# skill body");

		await store.snapshotCandidate("# skill body", v);
		expect(
			await fs.readFile(path.join(getSkillEvolutionDir("demo", agentDir), "candidates", `skill-${v}.md`), "utf8"),
		).toBe("# skill body");

		await store.writeState(state({ step: 3, status: "training" }));
		expect((await store.readState())?.step).toBe(3);

		await store.writeSplit({ train: [task("1"), task("2")], heldout: [task("3")] });
		const split = await store.readSplit();
		expect(split.train.map(t => t.id)).toEqual(["1", "2"]);
		expect(split.heldout.map(t => t.id)).toEqual(["3"]);

		const step: StepRecord = {
			step: 2,
			epoch: 2,
			action: "accept_new_best",
			proposed: [],
			accepted: [],
			rejected: [],
			applyReports: [],
			candidateHash: "abc",
			selectionHardBefore: 0.5,
			selectionSoftBefore: 0.5,
			selectionHardAfter: 0.6,
			selectionSoftAfter: 0.6,
			gateAction: "accept_new_best",
			trainHard: 0.5,
			trainSoft: 0.55,
			abstentions: 0,
		};
		await store.writeStep(step);
		expect(await store.readSteps()).toEqual([step]);
	});

	it("ledger appends jsonl and survives a torn final line", async () => {
		const store = new EvolutionStorage("demo", agentDir);
		const entry: LedgerEntry = {
			ts: "2026-10-13T00:00:00Z",
			event: "step-start",
			skill: "demo",
			step: 1,
			detail: "",
		};
		await store.appendLedger(entry);
		await store.appendLedger({ ...entry, event: "step-end" });
		const file = path.join(getSkillEvolutionDir("demo", agentDir), "ledger.jsonl");
		await fs.appendFile(file, '{"truncated');
		const ledger = await store.readLedger();
		expect(ledger.map(e => e.event)).toEqual(["step-start", "step-end"]);
	});

	it("no temp files remain after atomic writes", async () => {
		const store = new EvolutionStorage("demo", agentDir);
		await store.writeSkill("x");
		await store.writeState(state());
		const leftovers = await fs.readdir(getSkillEvolutionDir("demo", agentDir));
		expect(leftovers.filter(n => n.endsWith(".tmp"))).toEqual([]);
	});
});
