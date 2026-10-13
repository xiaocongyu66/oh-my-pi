import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Settings, settingsCapability } from "@oh-my-pi/pi-coding-agent/capability/settings";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

async function loadClaudeSettings(cwd: string): Promise<{ items: Settings[]; warnings: string[] }> {
	const result = await loadCapability<Settings>(settingsCapability.id, {
		cwd,
		providers: ["claude"],
	});
	return {
		items: result.items.filter(item => item._source.provider === "claude"),
		warnings: result.warnings ?? [],
	};
}

describe("claude settings discovery (project scope)", () => {
	let tempDir = "";
	let originalClaudeConfigDir: string | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-discovery-"));
		originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
		delete process.env.CLAUDE_CONFIG_DIR;
		// Keep user-scope discovery inside the temp home; never touch the real ~/.claude.
		vi.spyOn(os, "homedir").mockReturnValue(tempDir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (originalClaudeConfigDir === undefined) {
			delete process.env.CLAUDE_CONFIG_DIR;
		} else {
			process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
		}
		await removeWithRetries(tempDir);
	});

	test("loads settings.local.json after settings.json so the local layer wins the merge", async () => {
		const claudeDir = path.join(tempDir, "project", ".claude");
		await fs.mkdir(claudeDir, { recursive: true });
		await fs.writeFile(
			path.join(claudeDir, "settings.json"),
			JSON.stringify({ permissions: { allow: ["Bash(git:*)"] } }),
		);
		await fs.writeFile(
			path.join(claudeDir, "settings.local.json"),
			JSON.stringify({ permissions: { allow: ["Bash(git:*)", "Bash(npm:*)"] } }),
		);

		const { items, warnings } = await loadClaudeSettings(path.join(tempDir, "project"));
		const projectItems = items.filter(item => item.level === "project");

		// The consumer (config/settings.ts `#readProjectSettings`) deep-merges
		// project items in this exact order, later wins: local must come last.
		expect(projectItems.map(item => item.path)).toEqual([
			path.join(claudeDir, "settings.json"),
			path.join(claudeDir, "settings.local.json"),
		]);
		// Arrays are replaced wholesale by the merge, so the surviving (local)
		// allow list carries both rules: local wins and git+npm stay visible.
		expect(projectItems.at(-1)?.data).toMatchObject({ permissions: { allow: ["Bash(git:*)", "Bash(npm:*)"] } });
		expect(warnings).toEqual([]);
	});

	test("skips a corrupt settings.local.json without affecting settings.json", async () => {
		const claudeDir = path.join(tempDir, "project", ".claude");
		await fs.mkdir(claudeDir, { recursive: true });
		await fs.writeFile(
			path.join(claudeDir, "settings.json"),
			JSON.stringify({ permissions: { allow: ["Bash(git:*)"] } }),
		);
		await fs.writeFile(path.join(claudeDir, "settings.local.json"), "{ not valid json");

		const { items, warnings } = await loadClaudeSettings(path.join(tempDir, "project"));

		expect(items.map(item => item.path)).toEqual([path.join(claudeDir, "settings.json")]);
		expect(items[0]?.data).toMatchObject({ permissions: { allow: ["Bash(git:*)"] } });
		expect(warnings.some(warning => warning.includes("settings.local.json"))).toBe(true);
	});

	test("loads settings.local.json alone when the shared settings file is absent", async () => {
		const claudeDir = path.join(tempDir, "project", ".claude");
		await fs.mkdir(claudeDir, { recursive: true });
		await fs.writeFile(
			path.join(claudeDir, "settings.local.json"),
			JSON.stringify({ permissions: { allow: ["Bash(npm:*)"] } }),
		);

		const { items, warnings } = await loadClaudeSettings(path.join(tempDir, "project"));

		expect(items.map(item => item.path)).toEqual([path.join(claudeDir, "settings.local.json")]);
		expect(items[0]?.level).toBe("project");
		expect(warnings).toEqual([]);
	});
});
