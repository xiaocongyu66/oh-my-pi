import { describe, expect, it } from "bun:test";

import { clusterTopic, extractTasksFromSession, mineTopic, splitTasks } from "../../src/evolution/harvest";
import type { TrainingTask } from "../../src/evolution/types";

const msg = (role: string, content: unknown, attribution?: string) =>
	JSON.stringify({
		type: "message",
		id: Math.random().toString(16).slice(2),
		message: { role, content, attribution },
	});

const session = (...lines: string[]) =>
	[JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/tmp", timestamp: "x" }), ...lines].join("\n");

const USER = "please refactor the payment module to extract retries into a helper";
const FOLLOWUP = "and also add unit tests for the retry helper please";

describe("harvest", () => {
	it("extracts user tasks with their tool trajectory, skipping injected/system turns", () => {
		const raw = session(
			msg("user", [{ type: "text", text: USER }], "user"),
			msg("assistant", [
				{ type: "toolCall", name: "read", arguments: {} },
				{ type: "toolCall", name: "edit", arguments: {} },
			]),
			msg("user", [{ type: "text", text: "hi" }], "user"), // too short
			msg("user", [{ type: "text", text: USER }], "autolearn"), // injected, not user
			msg("user", [{ type: "text", text: FOLLOWUP }], "user"), // no tools after -> no digest
		);
		const tasks = extractTasksFromSession("/sessions/-tmp/s1.jsonl", raw);
		expect(tasks).toHaveLength(1);
		expect(tasks[0]?.prompt).toBe(USER);
		expect(tasks[0]?.trajectoryDigest).toBe("read,edit");
		expect(tasks[0]?.id).toBe("s1.jsonl#0");
	});

	it("stops trajectory collection at the next user message", () => {
		const raw = session(
			msg("user", [{ type: "text", text: USER }], "user"),
			msg("assistant", [{ type: "toolCall", name: "read", arguments: {} }]),
			msg("user", [{ type: "text", text: FOLLOWUP }], "user"),
			msg("assistant", [{ type: "toolCall", name: "bash", arguments: {} }]),
		);
		const tasks = extractTasksFromSession("s.jsonl", raw);
		const first = tasks.find(t => t.id.endsWith("#0"));
		expect(first?.trajectoryDigest).toBe("read");
		expect(first?.trajectoryDigest).not.toContain("bash");
	});

	it("tolerates torn lines", () => {
		const raw =
			session(
				msg("user", [{ type: "text", text: USER }], "user"),
				msg("assistant", [{ type: "toolCall", name: "read", arguments: {} }]),
			) + `\n{"type":"mess`;
		expect(extractTasksFromSession("s.jsonl", raw)).toHaveLength(1);
	});

	it("topic clustering is deterministic and merges near-duplicate prompts", () => {
		const a = clusterTopic("Refactor the payment module to extract retries");
		const b = clusterTopic("refactor payment module: extract retries please");
		expect(a).toBe(b);
		expect(clusterTopic("fix the flaky ci pipeline for docker builds")).not.toBe(a);
	});

	const task = (id: string, topic = "x"): TrainingTask => ({
		id,
		prompt: `p${id}`,
		topic,
		sourceSession: "s",
		trajectoryDigest: "read",
	});

	it("split is deterministic on the same corpus and respects the fraction", () => {
		const corpus = Array.from({ length: 20 }, (_, i) => task(`t${i}`));
		const s1 = splitTasks(corpus, 0.2);
		const s2 = splitTasks([...corpus].reverse(), 0.2);
		expect(s1.heldout.map(t => t.id).sort()).toEqual(s2.heldout.map(t => t.id).sort());
		expect(s1.heldout).toHaveLength(4);
		expect(s1.train).toHaveLength(16);
		expect(new Set([...s1.train, ...s1.heldout].map(t => t.id))).toHaveLength(20);
	});

	it("split keeps at least one held-out member for corpora > 4", () => {
		const small = Array.from({ length: 5 }, (_, i) => task(`t${i}`));
		expect(splitTasks(small, 0.01, 1).heldout.length).toBeGreaterThanOrEqual(1);
	});

	it("mineTopic keeps topics with enough members", () => {
		const corpus = [task("1", "a"), task("2", "a"), task("3", "b")];
		expect(mineTopic([corpus[0] as TrainingTask], corpus, 2).map(t => t.id)).toEqual(["1", "2"]);
		expect(mineTopic([corpus[2] as TrainingTask], corpus, 2)).toEqual([]);
	});
});
