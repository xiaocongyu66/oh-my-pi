/**
 * Disk layout + IO for the skill-evolution trainer.
 *
 * All evolution state lives under `~/.omp/agent/evolution/<slug>/`, isolated
 * from user-authored files and never written into project directories:
 *
 *   skill.md            working skill version (optimizer edits applied here)
 *   state.json          cross-epoch bookkeeping (EvolutionState)
 *   ledger.jsonl        append-only audit trail (LedgerEntry)
 *   epochs/NNN.json     per-epoch records (EpochRecord)
 *   candidates/         snapshots per accepted version (skill-<hash>.md)
 *   eval/train.jsonl    harvested train tasks
 *   eval/heldout.jsonl  harvested held-out tasks (never shown to optimizer)
 *
 * Every JSON write is tmp-file + rename (atomic). All IO lives in this file;
 * the trainer core is pure.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";

import { sanitizeSkillName } from "../autolearn/managed-skills";
import type { EvalSplit, EvolutionState, LedgerEntry, StepRecord, TrainingTask } from "./types";

export function getEvolutionRoot(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "evolution");
}

export function getSkillEvolutionDir(slug: string, agentDir: string = getAgentDir()): string {
	return path.join(getEvolutionRoot(agentDir), sanitizeSkillName(slug));
}

/** scoring.py skill_hash: sha256 hex, first 16 chars. */
export function skillVersion(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

async function writeFileAtomic(file: string, data: string): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	// Random suffix: pid alone collides when two trainings run concurrently in
	// one process (nightly tick + manual /evolve train), crashing the loser's
	// rename with ENOENT.
	const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
	await fs.writeFile(tmp, data);
	await fs.rename(tmp, file);
}

async function readJsonOpt<T>(file: string): Promise<T | undefined> {
	try {
		return JSON.parse(await fs.readFile(file, "utf8")) as T;
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
}

async function readJsonlOpt<T>(file: string): Promise<T[]> {
	let raw: string;
	try {
		raw = await fs.readFile(file, "utf8");
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
	const rows: T[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			rows.push(JSON.parse(trimmed) as T);
		} catch {
			// A torn final line (crash mid-append) must not poison the store.
			continue;
		}
	}
	return rows;
}

export class EvolutionStorage {
	constructor(
		readonly slug: string,
		private readonly agentDir: string = getAgentDir(),
	) {}

	private dir(...parts: string[]): string {
		return path.join(getSkillEvolutionDir(this.slug, this.agentDir), ...parts);
	}

	async ensureRoot(): Promise<void> {
		await fs.mkdir(this.dir(), { recursive: true });
	}

	async writeSkill(content: string): Promise<string> {
		await writeFileAtomic(this.dir("skill.md"), content);
		return skillVersion(content);
	}

	async readSkill(): Promise<string | undefined> {
		try {
			return await fs.readFile(this.dir("skill.md"), "utf8");
		} catch (err) {
			if (isEnoent(err)) return undefined;
			throw err;
		}
	}

	async snapshotCandidate(content: string, version: string): Promise<void> {
		await writeFileAtomic(this.dir("candidates", `skill-${version}.md`), content);
	}

	/** Deployed-artifact candidate (trainer.py best_skill.md). */
	async writeBestSkill(content: string): Promise<void> {
		await writeFileAtomic(this.dir("best_skill.md"), content);
	}

	async readBestSkill(): Promise<string | undefined> {
		try {
			return await fs.readFile(this.dir("best_skill.md"), "utf8");
		} catch (err) {
			if (isEnoent(err)) return undefined;
			throw err;
		}
	}

	async writeState(state: EvolutionState): Promise<void> {
		await writeFileAtomic(this.dir("state.json"), JSON.stringify(state, null, 1));
	}

	async readState(): Promise<EvolutionState | undefined> {
		return readJsonOpt<EvolutionState>(this.dir("state.json"));
	}

	async appendLedger(entry: LedgerEntry): Promise<void> {
		await this.ensureRoot();
		await fs.appendFile(this.dir("ledger.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	async readLedger(): Promise<LedgerEntry[]> {
		return readJsonlOpt<LedgerEntry>(this.dir("ledger.jsonl"));
	}

	async writeStep(record: StepRecord): Promise<void> {
		const padded = String(record.step).padStart(4, "0");
		await writeFileAtomic(this.dir("steps", `${padded}.json`), JSON.stringify(record, null, 1));
	}

	async readSteps(): Promise<StepRecord[]> {
		let names: string[];
		try {
			names = await fs.readdir(this.dir("steps"));
		} catch (err) {
			if (isEnoent(err)) return [];
			throw err;
		}
		const steps: StepRecord[] = [];
		for (const name of names.filter(n => n.endsWith(".json")).sort()) {
			const rec = await readJsonOpt<StepRecord>(this.dir("steps", name));
			if (rec) steps.push(rec);
		}
		return steps;
	}

	async writeSplit(split: EvalSplit): Promise<void> {
		const encode = (tasks: TrainingTask[]) => `${tasks.map(t => JSON.stringify(t)).join("\n")}\n`;
		await writeFileAtomic(this.dir("eval", "train.jsonl"), encode(split.train));
		await writeFileAtomic(this.dir("eval", "heldout.jsonl"), encode(split.heldout));
	}

	async readSplit(): Promise<EvalSplit> {
		return {
			train: await readJsonlOpt<TrainingTask>(this.dir("eval", "train.jsonl")),
			heldout: await readJsonlOpt<TrainingTask>(this.dir("eval", "heldout.jsonl")),
		};
	}
}
