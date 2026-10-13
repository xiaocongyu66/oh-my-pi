import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

const BOOTSTRAP_MARKER = "<project-bootstrap>";

/**
 * When no project-level instruction file is loaded, the prompt invites the
 * model to create one itself (see project-prompt.md `project-bootstrap`).
 * User-level files (no `depth`) must not suppress it; project-level files
 * (numeric `depth`) must. Subagents never see the invitation.
 */
describe("system prompt project-bootstrap section", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-bootstrap-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-bootstrap-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	async function render(
		options: {
			contextFiles?: Array<{ path: string; content: string; depth?: number }>;
			toolNames?: string[];
			subagent?: boolean;
		} = {},
	): Promise<string> {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: options.contextFiles ?? [],
			skills: [],
			rules: [],
			toolNames: options.toolNames ?? ["read", "bash", "edit", "write"],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			subagent: options.subagent,
		});
		return systemPrompt.join("\n\n");
	}

	it("invites the model to create project instruction files when none are loaded", async () => {
		const prompt = await render();
		expect(prompt).toContain(BOOTSTRAP_MARKER);
		expect(prompt).toContain("CLAUDE.md");
		expect(prompt).toContain(".claude/rules/");
		expect(prompt).toContain(".claude/skills/");
		// Creating one must be followed by telling the user.
		expect(prompt).toContain("tell the user");
	});

	it("stays out of the prompt when a project-level CLAUDE.md is loaded", async () => {
		const claudePath = path.join(tempDir, "CLAUDE.md");
		fs.writeFileSync(claudePath, "# Build\nRun `bun test`.\n");
		const prompt = await render({
			contextFiles: [{ path: claudePath, content: "# Build\nRun `bun test`.\n", depth: 0 }],
		});
		expect(prompt).not.toContain(BOOTSTRAP_MARKER);
		// Sanity: the context file itself still renders.
		expect(prompt).toContain("Run `bun test`.");
	});

	it("stays out when a project-level instruction file comes from an ancestor directory", async () => {
		const prompt = await render({
			contextFiles: [{ path: path.join(path.dirname(tempDir), "AGENTS.md"), content: "root rules", depth: 1 }],
		});
		expect(prompt).not.toContain(BOOTSTRAP_MARKER);
	});

	it("is still offered when only a user-level instruction file is loaded", async () => {
		const userFile = path.join(tempHomeDir, "AGENTS.md");
		const prompt = await render({
			// User-level files carry no `depth`; they are global prefs, not project docs.
			contextFiles: [{ path: userFile, content: "global prefs", depth: undefined }],
		});
		expect(prompt).toContain(BOOTSTRAP_MARKER);
	});

	it("stays out of subagent prompts", async () => {
		const prompt = await render({ subagent: true });
		expect(prompt).not.toContain(BOOTSTRAP_MARKER);
	});

	it("stays out when the write tool is unavailable", async () => {
		const prompt = await render({ toolNames: ["read", "bash"] });
		expect(prompt).not.toContain(BOOTSTRAP_MARKER);
	});
});
