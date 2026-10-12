import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseFrontmatter, setAgentDir } from "@oh-my-pi/pi-utils";

import { MAX_MANAGED_SKILL_BYTES } from "../../src/autolearn/managed-skills";
import { promoteSkill, readProvenance, serializeProvenance } from "../../src/evolution/promotion";
import type { Provenance } from "../../src/evolution/promotion";

const provenance = (over: Partial<Provenance> = {}): Provenance => ({
	skill: "demo-skill",
	epochs: 4,
	validationScoreBefore: 0.42,
	validationScoreAfter: 0.71,
	gateAction: "accept_new_best",
	bestScore: 0.71,
	bestStep: 3,
	l2AvgQuality: 0.66,
	promotedAt: "2026-10-13T00:00:00.000Z",
	...over,
});

describe("evolution promotion", () => {
	let agentDir: string;
	beforeEach(async () => {
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-promotion-"));
		setAgentDir(agentDir);
	});
	afterEach(async () => {
		await fs.rm(agentDir, { recursive: true, force: true });
	});

	it("promotes into the managed-skills dir and nowhere else", async () => {
		const { path: file } = await promoteSkill({
			slug: "demo-skill",
			description: "Automated skill",
			body: "# Demo\nDo the thing well.",
			provenance: provenance(),
		});
		expect(file).toBe(path.join(agentDir, "managed-skills", "demo-skill", "SKILL.md"));
		const content = await fs.readFile(file, "utf8");
		expect(content).toContain("Do the thing well.");
		// red line: no authored-skills or project dirs touched
		await expect(fs.stat(path.join(agentDir, "skills"))).rejects.toThrow();
		await expect(fs.stat(path.join(agentDir, "evolution"))).rejects.toThrow();
	});

	it("keeps frontmatter valid: name/description parse, provenance lives in the body", async () => {
		const { path: file } = await promoteSkill({
			slug: "demo-skill",
			description: "Automated skill",
			body: "Body text.",
			provenance: provenance(),
		});
		const content = await fs.readFile(file, "utf8");
		const { frontmatter, body } = parseFrontmatter(content, { source: file });
		expect(frontmatter.name).toBe("demo-skill");
		expect(frontmatter.description).toBe("Automated skill");
		// provenance header sits after the frontmatter close delimiter, on disk…
		expect(content).toContain("\n\n<!-- omp-provenance ");
		// …and repair-mode parseFrontmatter strips HTML comments from its body
		// view, so frontmatter-only consumers never see machine metadata.
		expect(body).toBe("Body text.");
	});

	it("readProvenance round-trips through the written file", async () => {
		const { path: file } = await promoteSkill({
			slug: "demo-skill",
			description: "Automated skill",
			body: "Body.",
			provenance: provenance(),
		});
		const content = await fs.readFile(file, "utf8");
		expect(readProvenance(content)).toEqual(provenance());
	});

	it("readProvenance round-trips undefined l2AvgQuality", () => {
		const p = provenance({ l2AvgQuality: undefined });
		const round = readProvenance(serializeProvenance(p));
		expect(round).toEqual(p);
		expect(round?.l2AvgQuality).toBeUndefined();
	});

	it("readProvenance is tolerant: no marker, bad JSON, wrong shape", () => {
		expect(readProvenance("# just a skill")).toBeUndefined();
		expect(readProvenance("<!-- omp-provenance not json -->")).toBeUndefined();
		expect(readProvenance('<!-- omp-provenance {"skill":1} -->')).toBeUndefined();
		// reject never promotes: not a valid gateAction in provenance
		expect(readProvenance('<!-- omp-provenance {"gateAction":"reject"} -->')).toBeUndefined();
		expect(readProvenance("")).toBeUndefined();
	});

	it("re-promotion updates the managed skill in place", async () => {
		await promoteSkill({
			slug: "demo-skill",
			description: "v1",
			body: "First.",
			provenance: provenance({ validationScoreAfter: 0.5, bestScore: 0.5 }),
		});
		const { path: file } = await promoteSkill({
			slug: "demo-skill",
			description: "v2",
			body: "Second.",
			provenance: provenance({ validationScoreAfter: 0.8, bestScore: 0.8 }),
		});
		const content = await fs.readFile(file, "utf8");
		expect(content).toContain("Second.");
		expect(content).not.toContain("First.");
		const p = readProvenance(content);
		expect(p?.validationScoreAfter).toBe(0.8);
	});

	it("oversize body is rejected and nothing is written", async () => {
		const bigBody = "x".repeat(MAX_MANAGED_SKILL_BYTES + 1);
		await expect(
			promoteSkill({
				slug: "demo-skill",
				description: "Automated skill",
				body: bigBody,
				provenance: provenance(),
			}),
		).rejects.toThrow(/limit/);
		await expect(fs.stat(path.join(agentDir, "managed-skills", "demo-skill", "SKILL.md"))).rejects.toThrow();
	});

	it("rejects path-escaping slugs before any write", async () => {
		await expect(
			promoteSkill({
				slug: "../evil",
				description: "nope",
				body: "nope",
				provenance: provenance({ skill: "../evil" }),
			}),
		).rejects.toThrow(/Invalid skill name/);
		await expect(fs.stat(path.join(agentDir, "managed-skills"))).rejects.toThrow();
	});

	it("refuses to serialize reject/invalid provenance", async () => {
		await expect(
			promoteSkill({
				slug: "demo-skill",
				description: "d",
				body: "b",
				// @ts-expect-error reject is not a promotable gate action
				provenance: provenance({ gateAction: "reject" }),
			}),
		).rejects.toThrow(/invalid provenance/);
		await expect(fs.stat(path.join(agentDir, "managed-skills"))).rejects.toThrow();
	});
});
