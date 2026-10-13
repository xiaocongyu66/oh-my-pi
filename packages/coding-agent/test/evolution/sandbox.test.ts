import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { assembleSandbox, cleanupSandbox } from "../../src/evolution/sandbox";

async function makeProject(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-l2-proj-"));
	await fs.mkdir(path.join(dir, ".git"), { recursive: true });
	await fs.writeFile(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main", "utf8");
	await fs.writeFile(path.join(dir, "README.md"), "# demo project", "utf8");
	await fs.mkdir(path.join(dir, "src"), { recursive: true });
	await fs.writeFile(path.join(dir, "src", "a.ts"), "export {};", "utf8");
	return dir;
}

describe("assembleSandbox", () => {
	it("copies the project but prunes .git", async () => {
		const projectDir = await makeProject();
		const sb = await assembleSandbox({ projectDir, slug: "demo", approvalModel: "review-model" });
		try {
			expect((await fs.stat(path.join(sb.workdir, "README.md"))).isFile()).toBe(true);
			await expect(fs.stat(path.join(sb.workdir, ".git"))).rejects.toThrow();
			expect((await fs.stat(path.join(sb.workdir, "src", "a.ts"))).isFile()).toBe(true);
		} finally {
			await cleanupSandbox(sb);
		}
		await expect(fs.stat(sb.root)).rejects.toThrow();
	});

	it("writes the candidate skill under managed-skills/<slug>/", async () => {
		const projectDir = await makeProject();
		const sb = await assembleSandbox({
			projectDir,
			slug: "deploy-helper",
			approvalModel: "m",
			skillContent: "# candidate skill body",
		});
		try {
			const body = await fs.readFile(path.join(sb.agentDir, "managed-skills", "deploy-helper", "SKILL.md"), "utf8");
			expect(body).toBe("# candidate skill body");
		} finally {
			await cleanupSandbox(sb);
		}
	});

	it("sandbox config.yml sets permissions.defaultMode auto and the approval advisor role", async () => {
		const projectDir = await makeProject();
		const sb = await assembleSandbox({ projectDir, slug: "demo", approvalModel: "reviewer-model" });
		try {
			const yaml = await fs.readFile(path.join(sb.agentDir, "config.yml"), "utf8");
			expect(yaml).toContain("defaultMode: auto");
			expect(yaml).toContain('"reviewer-model"');
		} finally {
			await cleanupSandbox(sb);
		}
	});

	it("omits the modelRoles block when no approval model is given", async () => {
		const projectDir = await makeProject();
		const sb = await assembleSandbox({ projectDir, slug: "demo", approvalModel: "" });
		try {
			const yaml = await fs.readFile(path.join(sb.agentDir, "config.yml"), "utf8");
			expect(yaml).toContain("defaultMode: auto");
			expect(yaml).not.toContain("modelRoles");
		} finally {
			await cleanupSandbox(sb);
		}
	});

	it("throws (and cleans up) when the project exceeds the copy budget", async () => {
		const projectDir = await makeProject();
		await expect(assembleSandbox({ projectDir, slug: "demo", approvalModel: "m", maxCopyBytes: 10 })).rejects.toThrow(
			"too large",
		);
		// Failure path must not leak a tmp root: assemble cleaned it itself.
		const tmpRoots = await fs.readdir(os.tmpdir());
		expect(tmpRoots.filter(n => n.startsWith("omp-evol-l2-"))).toEqual([]);
	});

	it("cleans up even when the caller aborts between samples", async () => {
		const projectDir = await makeProject();
		const sb = await assembleSandbox({ projectDir, slug: "demo", approvalModel: "m" });
		await cleanupSandbox(sb);
		// Double-cleanup is safe.
		await cleanupSandbox(sb);
		await expect(fs.access(sb.root)).rejects.toThrow();
		await fs.rm(projectDir, { recursive: true, force: true });
	});
});
