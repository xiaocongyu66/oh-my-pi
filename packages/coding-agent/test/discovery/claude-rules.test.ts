import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ContextFile, contextFileCapability } from "@oh-my-pi/pi-coding-agent/capability/context-file";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

async function loadClaudeContextFiles(cwd: string): Promise<{ items: ContextFile[]; warnings: string[] }> {
	const result = await loadCapability<ContextFile>(contextFileCapability.id, {
		cwd,
		providers: ["claude"],
	});
	return {
		items: result.items.filter(item => item._source.provider === "claude"),
		warnings: result.warnings ?? [],
	};
}

describe("claude .claude/rules discovery", () => {
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

	test("loads .claude/rules/**/*.md recursively as additive project context files", async () => {
		const project = path.join(tempDir, "project");
		const rulesDir = path.join(project, ".claude", "rules");
		await fs.mkdir(path.join(rulesDir, "sub"), { recursive: true });
		await fs.writeFile(path.join(rulesDir, "a.md"), "rule a");
		await fs.writeFile(path.join(rulesDir, "sub", "b.md"), "rule b");

		const { items, warnings } = await loadClaudeContextFiles(project);

		expect(items.map(item => item.path)).toEqual([path.join(rulesDir, "a.md"), path.join(rulesDir, "sub", "b.md")]);
		expect(items.every(item => item.level === "project" && item.additive === true)).toBe(true);
		expect(items.map(item => item.content)).toEqual(["rule a", "rule b"]);
		expect(warnings).toEqual([]);
	});

	test("rules load alongside CLAUDE.md without shadowing it", async () => {
		const project = path.join(tempDir, "project");
		const claudeDir = path.join(project, ".claude");
		await fs.mkdir(path.join(claudeDir, "rules"), { recursive: true });
		await fs.writeFile(path.join(claudeDir, "CLAUDE.md"), "main context");
		await fs.writeFile(path.join(claudeDir, "rules", "a.md"), "rule a");

		const { items } = await loadClaudeContextFiles(project);

		expect(items.map(item => item.path)).toEqual([
			path.join(claudeDir, "CLAUDE.md"),
			path.join(claudeDir, "rules", "a.md"),
		]);
	});

	test("loads unconditional rules and skips path-scoped rules like Claude Code", async () => {
		const project = path.join(tempDir, "project");
		const rulesDir = path.join(project, ".claude", "rules");
		await fs.mkdir(path.join(rulesDir, "sub"), { recursive: true });
		// Unconditional rule: frontmatter must be stripped from the context content.
		await fs.writeFile(path.join(rulesDir, "a.md"), "---\ndescription: style\n---\nstyle rules\n");
		// Match-all `paths: "**"` behaves as unconditional (CC parseFrontmatterPaths).
		await fs.writeFile(path.join(rulesDir, "all.md"), '---\npaths: "**"\n---\nall files\n');
		// Path-scoped rule: CC defers it to file-access activation; omp skips it with a warning.
		await fs.writeFile(path.join(rulesDir, "sub", "scoped.md"), '---\npaths: ["src/**"]\n---\nscoped rules\n');
		// Blank after frontmatter: dropped without a warning (CC blank-content skip).
		await fs.writeFile(path.join(rulesDir, "blank.md"), "---\ndescription: empty\n---\n   \n");

		const { items, warnings } = await loadClaudeContextFiles(project);

		expect(items.map(item => item.path)).toEqual([path.join(rulesDir, "a.md"), path.join(rulesDir, "all.md")]);
		expect(items[0]?.content).toBe("style rules");
		expect(items[1]?.content).toBe("all files");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("scoped.md");
	});

	test("no entries and no warnings when .claude/rules does not exist", async () => {
		const project = path.join(tempDir, "project");
		await fs.mkdir(path.join(project, ".claude"), { recursive: true });

		const { items, warnings } = await loadClaudeContextFiles(project);

		expect(items).toEqual([]);
		expect(warnings).toEqual([]);
	});
});
