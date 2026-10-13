import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { ModelTransport } from "../../src/evolution/judge";
import { runL2Verification, runRealSample, type L2Options } from "../../src/evolution/l2";
import { EvolutionStorage } from "../../src/evolution/storage";
import type { TrainingTask } from "../../src/evolution/types";

// Inline fake omp: a .ts file invoked via the bun binary as its shebang
// interpreter. The positional prompt (after `-p`, the real print-mode flag,
// cli/args.ts:337) carries a directive token that decides behavior.
const FAKE_OMP_SOURCE = `#!${process.execPath}
const argv = process.argv.slice(2);
const flag = argv.indexOf("-p");
const prompt = flag >= 0 ? argv.slice(flag + 1).join(" ") : "";
if (prompt.includes("@@SLOW")) {
	await new Promise(resolve => setTimeout(resolve, 30_000));
	console.log("eventually done");
	process.exit(0);
}
if (prompt.includes("@@EXIT1")) {
	console.log("partial progress, task unfinished");
	process.exit(1);
}
if (prompt.includes("@@GARBAGE")) {
	console.log("no structured answer here");
	process.exit(0);
}
console.log("TASK COMPLETE: module refactored, all tests pass");
`;

const task = (id: string, prompt = "refactor the module"): TrainingTask => ({
	id,
	prompt,
	topic: "refactor",
	sourceSession: "s.jsonl",
	trajectoryDigest: "read,edit",
});

const judgeAlways =
	(pass: boolean, quality: number): ModelTransport =>
	async () =>
		`{"pass": ${pass}, "quality": ${quality}, "rationale": "scripted"}`;

const judgeGarbage: ModelTransport = async () => "cannot grade this";

describe("evolution L2 real execution", () => {
	let workdir: string;
	let agentDir: string;
	let ompPath: string;

	const opts = (over: Partial<L2Options> = {}): L2Options => ({
		ompPath,
		timeoutMs: 5_000,
		projectDir: workdir,
		approvalModel: "review-model",
		passThreshold: 0.5,
		...over,
	});

	beforeEach(async () => {
		workdir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-l2-work-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-l2-agent-"));
		ompPath = path.join(workdir, "fake-omp.ts");
		await fs.writeFile(ompPath, FAKE_OMP_SOURCE);
		await fs.chmod(ompPath, 0o755);
	});
	afterEach(async () => {
		await fs.rm(workdir, { recursive: true, force: true });
		await fs.rm(agentDir, { recursive: true, force: true });
	});

	it("normal completion: stdout is judged, completed=true", async () => {
		const result = await runRealSample(task("t1"), {
			judge: judgeAlways(true, 0.8),
			judgeModel: "j",
			opts: opts(),
		});
		expect(result).toEqual({ taskId: "t1", completed: true, timedOut: false, quality: 0.8 });
	});

	it("timeout: process killed, no judge call, hard=0 sample", async () => {
		let judgeCalls = 0;
		const spy: ModelTransport = async () => {
			judgeCalls++;
			return '{"pass": true, "quality": 1, "rationale": "r"}';
		};
		const result = await runRealSample(task("t2", "@@SLOW"), {
			judge: spy,
			judgeModel: "j",
			opts: opts({ timeoutMs: 250 }),
		});
		expect(result).toEqual({ taskId: "t2", completed: false, timedOut: true, quality: undefined });
		expect(judgeCalls).toBe(0);
	});

	it("non-zero exit: completed=false but stdout still judged (codex_harness.py:951-953)", async () => {
		const result = await runRealSample(task("t3", "@@EXIT1"), {
			judge: judgeAlways(false, 0.1),
			judgeModel: "j",
			opts: opts(),
		});
		expect(result).toEqual({ taskId: "t3", completed: false, timedOut: false, quality: 0.1 });
	});

	it("judge abstains on unparseable output: score undefined, no throw", async () => {
		const result = await runRealSample(task("t4", "@@GARBAGE"), {
			judge: judgeGarbage,
			judgeModel: "j",
			opts: opts(),
		});
		expect(result).toEqual({ taskId: "t4", completed: true, timedOut: false, quality: undefined });
	});

	it("spawn failure (missing binary) degrades to a failed sample, never throws", async () => {
		const result = await runRealSample(task("t5"), {
			judge: judgeAlways(true, 1),
			judgeModel: "j",
			opts: opts({ ompPath: "/nonexistent/omp-binary" }),
		});
		expect(result).toEqual({ taskId: "t5", completed: false, timedOut: false, quality: undefined });
	});

	it("passed=true: all samples judged pass clear the threshold", async () => {
		const { results, passed } = await runL2Verification([task("a"), task("b")], {
			judge: judgeAlways(true, 0.9),
			judgeModel: "j",
			opts: opts({ passThreshold: 0.5 }),
		});
		expect(passed).toBe(true);
		expect(results).toHaveLength(2);
		expect(results.every(r => r.completed)).toBe(true);
	});

	it("passed=false: failed samples count 0 in the mean, never dropped (scoring.py:21)", async () => {
		const { results, passed } = await runL2Verification([task("a"), task("t-out", "@@SLOW")], {
			judge: judgeAlways(true, 1),
			judgeModel: "j",
			opts: opts({ passThreshold: 0.75, timeoutMs: 250 }),
		});
		// mean hard = 1/2 = 0.5 < 0.75 — the timeout row stays in the denominator.
		expect(passed).toBe(false);
		expect(results).toHaveLength(2);
		expect(results.find(r => r.taskId === "t-out")?.timedOut).toBe(true);
	});

	it("empty task list fails closed (scoring.py:12-13)", async () => {
		const { results, passed } = await runL2Verification([], {
			judge: judgeAlways(true, 1),
			judgeModel: "j",
			opts: opts(),
		});
		expect(results).toEqual([]);
		expect(passed).toBe(false);
	});

	it("writes an l2-end ledger entry when storage is provided", async () => {
		const storage = new EvolutionStorage("demo", agentDir);
		const { passed } = await runL2Verification([task("a")], {
			judge: judgeAlways(true, 0.7),
			judgeModel: "j",
			opts: opts({ passThreshold: 0.5 }),
			storage,
		});
		expect(passed).toBe(true);
		const ledger = await storage.readLedger();
		const entry = ledger.find(e => e.event === "l2-end");
		expect(entry).toBeDefined();
		expect(entry?.detail).toContain("passed=true");
	});

	it("runs without storage (no ledger write, no throw)", async () => {
		const { results, passed } = await runL2Verification([task("a")], {
			judge: judgeAlways(true, 0.7),
			judgeModel: "j",
			opts: opts(),
		});
		expect(passed).toBe(true);
		expect(results[0]).toEqual({ taskId: "a", completed: true, timedOut: false, quality: 0.7 });
	});
});
