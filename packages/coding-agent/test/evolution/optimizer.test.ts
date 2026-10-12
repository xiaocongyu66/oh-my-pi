import { describe, expect, it } from "bun:test";

import {
	applyEditWithReport,
	applyPatchWithReport,
	estimateTokens,
	parseEditOps,
	rankAndSelect,
	selectLowRollouts,
} from "../../src/evolution/optimizer";
import type { ModelTransport } from "../../src/evolution/judge";
import type { Rollout } from "../../src/evolution/types";

const SKILL =
	"# Skill\nBase guidance.\n\n## Steps\nDo the thing.\n\n<!-- SLOW_UPDATE_START -->\nslow region\n<!-- SLOW_UPDATE_END -->";

describe("optimizer edits (skill.py port)", () => {
	it("append lands at tail; before protected region when present", () => {
		const plain = applyEditWithReport("# A\nbody", { op: "append", target: "", content: "new", why: "", tokens: 1 });
		expect(plain.skill).toBe("# A\nbody\n\nnew\n");
		expect(plain.report.status).toBe("applied_append");
		const guarded = applyEditWithReport(SKILL, { op: "append", target: "", content: "new", why: "", tokens: 1 });
		expect(guarded.skill.indexOf("new")).toBeLessThan(guarded.skill.indexOf("<!-- SLOW_UPDATE_START -->"));
		expect(guarded.report.status).toBe("applied_append_before_protected_region");
	});

	it("insert_after inserts on the next line; falls back to append on miss", () => {
		const hit = applyEditWithReport(SKILL, {
			op: "insert_after",
			target: "## Steps",
			content: "sub",
			why: "",
			tokens: 1,
		});
		// skill.py inserts "\n<content>\n" at the START of the next line, so the
		// target's trailing newline is followed by a blank line — byte-faithful.
		expect(hit.skill).toContain("## Steps\n\nsub\n");
		expect(hit.report.status).toBe("applied_insert_after");
		const miss = applyEditWithReport(SKILL, {
			op: "insert_after",
			target: "NOPE",
			content: "sub",
			why: "",
			tokens: 1,
		});
		expect(miss.report.status).toBe("applied_insert_after_fallback_before_protected_region");
	});

	it("replace/delete need a verbatim target; protected region is skipped", () => {
		const rep = applyEditWithReport(SKILL, {
			op: "replace",
			target: "Do the thing.",
			content: "Do it well.",
			why: "",
			tokens: 1,
		});
		expect(rep.skill).toContain("Do it well.");
		expect(rep.report.status).toBe("applied_replace");
		const miss = applyEditWithReport(SKILL, {
			op: "replace",
			target: "not present",
			content: "x",
			why: "",
			tokens: 1,
		});
		expect(miss.report.status).toBe("skipped_replace_target_not_found");
		const del = applyEditWithReport(SKILL, {
			op: "delete",
			target: "Do the thing.",
			content: "",
			why: "",
			tokens: 1,
		});
		expect(del.skill).not.toContain("Do the thing.");
		const prot = applyEditWithReport(SKILL, {
			op: "replace",
			target: "slow region",
			content: "x",
			why: "",
			tokens: 1,
		});
		expect(prot.report.status).toBe("skipped_protected_region");
		expect(prot.skill).toContain("slow region");
	});

	it("applyPatchWithReport indexes every edit and strips protected markers from content", () => {
		const { text, reports } = applyPatchWithReport(SKILL, [
			{ op: "replace", target: "Do the thing.", content: "Do it well.", why: "", tokens: 1 },
			{ op: "delete", target: "missing", content: "", why: "", tokens: 1 },
		]);
		expect(reports.map(r => r.index)).toEqual([1, 2]);
		expect(reports[1]?.status).toBe("skipped_delete_target_not_found");
		expect(text).toContain("Do it well.");
	});
});

describe("optimizer parsing (reflect output)", () => {
	const limits = { maxEdits: 3, budgetTokens: 1000 };

	it("parses {edits:[...]} and bare arrays; drops malformed entries", () => {
		const a = parseEditOps('{"reasoning":"r","edits":[{"op":"append","target":"","content":"c","why":"w"}]}', limits);
		expect(a).toHaveLength(1);
		const b = parseEditOps('[{"op":"replace","target":"t","content":"c"}]', limits);
		expect(b).toHaveLength(1);
		expect(parseEditOps('{"edits":[{"op":"frobnicate"}]}', limits)).toEqual([]);
		expect(parseEditOps('{"edits":[{"op":"replace","content":"no target"}]}', limits)).toEqual([]);
		expect(parseEditOps("garbage", limits)).toEqual([]);
	});

	it("enforces the textual learning rate (maxEdits) as a hard cap", () => {
		const many = Array.from({ length: 6 }, (_, i) => ({ op: "append", target: "", content: `c${i}` }));
		expect(parseEditOps(JSON.stringify({ edits: many }), { maxEdits: 2, budgetTokens: 1000 })).toHaveLength(2);
	});

	it("token budget is a stop, not a filter", () => {
		const edits = [
			{ op: "append", target: "", content: "x".repeat(100) }, // ~25 tokens
			{ op: "append", target: "", content: "y".repeat(10000) }, // ~2500 tokens > budget
			{ op: "append", target: "", content: "z", why: "", tokens: 1 },
		];
		const out = parseEditOps(JSON.stringify({ edits }), { maxEdits: 3, budgetTokens: 100 });
		expect(out).toHaveLength(1);
		expect(estimateTokens("abcd")).toBe(1);
	});
});

describe("rankAndSelect (clip.py port)", () => {
	const edits = Array.from({ length: 5 }, (_, i) => ({
		op: "append" as const,
		target: "",
		content: `c${i}`,
		why: "",
		tokens: 1,
	}));

	it("pool within budget returned unchanged, no model call", async () => {
		let called = 0;
		const t: ModelTransport = async () => {
			called++;
			return "{}";
		};
		const out = await rankAndSelect({ transport: t, model: "m", skill: "s", edits: edits.slice(0, 2), maxEdits: 3 });
		expect(out).toHaveLength(2);
		expect(called).toBe(0);
	});

	it("over budget: keeps selected_indices in priority order, deduped, bounded", async () => {
		const t: ModelTransport = async () => '{"selected_indices": [4, 4, 1, 99, 0]}';
		const out = await rankAndSelect({ transport: t, model: "m", skill: "s", edits, maxEdits: 3 });
		expect(out.map(e => e.content)).toEqual(["c4", "c1", "c0"]);
	});

	it("malformed ranking falls back to order-preserving truncation", async () => {
		const t: ModelTransport = async () => "not json";
		const out = await rankAndSelect({ transport: t, model: "m", skill: "s", edits, maxEdits: 2 });
		expect(out.map(e => e.content)).toEqual(["c0", "c1"]);
	});
});

describe("selectLowRollouts", () => {
	const r = (taskId: string, quality: number | undefined, abstained = false): Rollout => ({
		taskId,
		skillVersion: "v",
		answer: "a",
		score: { taskId, pass: undefined, quality, abstained, rationale: "" },
	});
	it("worst first, abstentions excluded", () => {
		const out = selectLowRollouts([r("a", 0.5), r("b", undefined, true), r("c", 0.1), r("d", 0.9)], 2);
		expect(out.map(x => x.taskId)).toEqual(["c", "a"]);
	});
});
