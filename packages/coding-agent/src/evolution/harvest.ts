/**
 * Harvest + mine (SkillOpt "harvest → mine"): turn historical session jsonl
 * files into clustered replayable TrainingTasks.
 *
 * Deterministic by construction — topic clustering is lexical (no LLM) and
 * the train/held-out split uses a seeded PRNG — so a given set of session
 * files always yields the same split. Held-out tasks never feed the
 * optimizer (validation gate integrity, types.ts).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getSessionsDir, isEnoent } from "@oh-my-pi/pi-utils";

import type { EvalSplit, TrainingTask } from "./types";

interface SessionMessage {
	role: string;
	content: unknown;
	attribution?: string;
}

interface SessionEntry {
	type: string;
	message?: SessionMessage;
	cwd?: string;
	timestamp?: string;
}

interface TextBlock {
	type: string;
	text?: string;
	name?: string;
}

const MIN_PROMPT_CHARS = 20;
const MAX_TASKS_PER_SESSION = 5;
const STOPWORDS = new Set(
	"the a an to in on for of and or is are was be it this that with at as by from my your i you we please can could would do does fix add use using how what why when where me my".split(
		" ",
	),
);

function isTextBlock(b: unknown): b is TextBlock {
	return typeof b === "object" && b !== null && typeof (b as TextBlock).type === "string";
}

function blocksOf(message: SessionMessage): TextBlock[] {
	return Array.isArray(message.content) ? (message.content as unknown[]).filter(isTextBlock) : [];
}

/** Extract user task prompts and the tool-call digest that followed them. */
export function extractTasksFromSession(filePath: string, raw: string): TrainingTask[] {
	const entries: SessionEntry[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			entries.push(JSON.parse(trimmed) as SessionEntry);
		} catch {
			continue; // torn line
		}
	}
	const messages = entries.filter(e => e.type === "message" && e.message).map(e => e.message as SessionMessage);
	const tasks: TrainingTask[] = [];
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i] as SessionMessage;
		if (msg.role !== "user" || msg.attribution !== "user") continue;
		const text = blocksOf(msg)
			.filter(b => b.type === "text" && b.text)
			.map(b => b.text as string)
			.join(" ")
			.trim();
		if (text.length < MIN_PROMPT_CHARS) continue;
		if (text.startsWith("/") || text.startsWith("!") || text.startsWith("$")) continue;
		// Tool calls made before the NEXT user message belong to this task.
		const tools: string[] = [];
		for (let j = i + 1; j < messages.length && tools.length < 20; j++) {
			const next = messages[j] as SessionMessage;
			if (next.role === "user") break;
			for (const b of blocksOf(next)) {
				if (b.type === "toolCall" && b.name) tools.push(b.name);
			}
		}
		if (tools.length === 0) continue; // no replayable trajectory
		tasks.push({
			id: `${path.basename(filePath)}#${i}`,
			prompt: text.slice(0, 2000),
			topic: clusterTopic(text),
			sourceSession: filePath,
			trajectoryDigest: [...new Set(tools)].join(","),
		});
		if (tasks.length >= MAX_TASKS_PER_SESSION) break;
	}
	return tasks;
}

/** Lexical topic key: content words of the prompt, sorted alphabetically.
 *  Same-ish tasks collapse to the same key deterministically. */
export function clusterTopic(prompt: string): string {
	const words = prompt
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.split(/\s+/)
		.filter(w => w.length > 1 && !STOPWORDS.has(w));
	return [...new Set(words)].sort().slice(0, 4).join("+");
}

/** Collect tasks from all session files newest-first (bounded scan). */
export async function harvestTasks(opts: { agentDir?: string; maxSessions?: number }): Promise<TrainingTask[]> {
	const root = getSessionsDir(opts.agentDir);
	const limit = opts.maxSessions ?? 200;
	let dirs: string[];
	try {
		dirs = await fs.readdir(root);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
	const files: { file: string; mtimeMs: number }[] = [];
	for (const dir of dirs) {
		let names: string[];
		try {
			names = await fs.readdir(path.join(root, dir));
		} catch {
			continue;
		}
		for (const name of names.filter(n => n.endsWith(".jsonl"))) {
			const file = path.join(root, dir, name);
			const stat = await fs.stat(file).catch(() => undefined);
			if (stat) files.push({ file, mtimeMs: stat.mtimeMs });
		}
	}
	files.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const tasks: TrainingTask[] = [];
	for (const { file } of files.slice(0, limit)) {
		const raw = await fs.readFile(file, "utf8").catch(() => "");
		if (raw) tasks.push(...extractTasksFromSession(file, raw));
	}
	return tasks;
}

/** mulberry32: tiny seeded PRNG so the split is reproducible across runs. */
function seededShuffle<T>(items: T[], seed: number): T[] {
	const arr = [...items];
	let s = seed >>> 0;
	const rand = () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[arr[i], arr[j]] = [arr[j] as T, arr[i] as T];
	}
	return arr;
}

/** Deterministic train/held-out split. `seed` derives from the task ids so
 *  re-harvesting the same corpus keeps the same held-out members. */
export function splitTasks(tasks: TrainingTask[], heldoutFraction: number, seedSalt = 0): EvalSplit {
	// Canonical id order first: the split must depend on the corpus CONTENT,
	// never on the order harvest happened to list files in.
	const canonical = [...tasks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const seed = canonical.reduce((acc, t) => acc + hash32(t.id), seedSalt) >>> 0;
	const shuffled = seededShuffle(canonical, seed);
	const heldCount = Math.min(
		shuffled.length,
		Math.max(shuffled.length > 4 ? 1 : 0, Math.round(shuffled.length * heldoutFraction)),
	);
	return {
		train: shuffled.slice(heldCount),
		heldout: shuffled.slice(0, heldCount),
	};
}

function hash32(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/** Keep topics with enough members to train on; SkillOpt needs repeated tasks. */
export function mineTopic(tasks: TrainingTask[], all: TrainingTask[], minMembers = 2): TrainingTask[] {
	return all.filter(t => t.topic === tasks[0]?.topic).length >= minMembers
		? all.filter(t => t.topic === tasks[0]?.topic)
		: [];
}
