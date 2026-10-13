/**
 * `/init` — analyze the current repository and generate a starting
 * AGENTS.md (project memory), mirroring Claude Code's `/init`. The file is
 * picked up by the existing agents-md context-file provider on the next
 * session; re-runs require `--force`; `--personal` writes the user-level
 * AGENTS.md under the agent dir instead.
 */
import fsp from "node:fs/promises";
import fs from "node:fs";
import * as path from "node:path";

import { getAgentDir } from "@oh-my-pi/pi-utils";
import { t } from "@oh-my-pi/pi-i18n";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime, SlashCommandSpec } from "./types";

const EXCLUDED_TREE_DIRS = new Set(["node_modules", ".git", "dist", "build", "target", ".venv", "__pycache__"]);
const BUILD_FILES = [
	"package.json",
	"Cargo.toml",
	"pyproject.toml",
	"go.mod",
	"Makefile",
	"BUILD.bazel",
	"CMakeLists.txt",
	"bunfig.toml",
] as const;

export interface InitContext {
	directoryTree: string;
	packageJson: string;
	readmeExcerpt: string;
	buildFiles: string[];
	hasExistingAgentsMd: boolean;
	hasExistingClaudeMd: boolean;
}

/** Two-level directory tree, skipping dependency/build/hidden dirs. */
async function collectDirectoryTree(cwd: string): Promise<string> {
	const lines: string[] = [];
	async function walk(dir: string, depth: number): Promise<void> {
		if (depth > 2) return;
		let entries;
		try {
			entries = await fsp.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.slice(0, 40)) {
			if (entry.name.startsWith(".") && depth === 0 && entry.name !== ".github") continue;
			if (entry.isDirectory()) {
				if (EXCLUDED_TREE_DIRS.has(entry.name)) continue;
				lines.push(`${"  ".repeat(depth)}${entry.name}/`);
				await walk(path.join(dir, entry.name), depth + 1);
			}
		}
	}
	await walk(cwd, 0);
	return lines.join("\n");
}

async function readIfExists(filePath: string): Promise<string | undefined> {
	try {
		return await fsp.readFile(filePath, "utf8");
	} catch {
		return undefined;
	}
}

/** Gather everything the analyzer prompt needs about the repo. */
export async function collectInitContext(cwd: string): Promise<InitContext> {
	const directoryTree = await collectDirectoryTree(cwd);
	const rawPackageJson = await readIfExists(path.join(cwd, "package.json"));
	let packageJson = "";
	if (rawPackageJson) {
		try {
			const parsed = JSON.parse(rawPackageJson) as {
				name?: string;
				scripts?: Record<string, string>;
				devDependencies?: Record<string, string>;
			};
			packageJson = JSON.stringify(
				{ name: parsed.name, scripts: parsed.scripts, devDependencies: parsed.devDependencies },
				null,
				1,
			);
		} catch {
			packageJson = "";
		}
	}
	const readme = await (async () => {
		for (const name of ["README.md", "README.txt", "readme.md"]) {
			const content = await readIfExists(path.join(cwd, name));
			if (content) return content;
		}
		return undefined;
	})();
	const buildFiles = BUILD_FILES.filter(file => fs.existsSync(path.join(cwd, file)));
	const hasExistingAgentsMd = (await readIfExists(path.join(cwd, "AGENTS.md"))) !== undefined;
	const hasExistingClaudeMd = (await readIfExists(path.join(cwd, "CLAUDE.md"))) !== undefined;
	return {
		directoryTree,
		packageJson,
		readmeExcerpt: (readme ?? "").split("\n").slice(0, 80).join("\n"),
		buildFiles,
		hasExistingAgentsMd,
		hasExistingClaudeMd,
	};
}

function renderInitPrompt(context: InitContext): string {
	return [
		"Analyze this repository and write a starting AGENTS.md: the persistent instructions an AI coding agent should hold in every session.",
		"",
		"Rules:",
		'- Include: what the project is, build/test/lint commands, project layout, coding conventions you can infer, "always do X" rules.',
		"- Only state facts derivable from the material below. Never invent commands or paths.",
		"- Keep it under 80 lines of concise markdown. No preamble, no code fences around the whole file.",
		"- If build files exist, prefer the commands their scripts/configs actually define.",
		"",
		"Detected build files:",
		context.buildFiles.length ? context.buildFiles.join(", ") : "(none)",
		"",
		"Directory tree (3 levels):",
		context.directoryTree || "(empty)",
		"",
		"package.json (name/scripts/devDependencies):",
		context.packageJson || "(none)",
		"",
		"README excerpt:",
		context.readmeExcerpt || "(none)",
		"",
		"Write the AGENTS.md content now.",
	].join("\n");
}

async function generateAgentsMd(context: InitContext, runtime: SlashCommandRuntime): Promise<string | undefined> {
	const model = runtime.session.model;
	if (!model) return undefined;
	const { completeSimple } = await import("@oh-my-pi/pi-ai");
	const apiKey = await runtime.session.modelRegistry.getApiKey(model, runtime.session.sessionId);
	const message = await completeSimple(
		model,
		{
			systemPrompt: ["You write concise, factual AGENTS.md files for software repositories."],
			messages: [{ role: "user", content: renderInitPrompt(context), timestamp: Date.now() }],
		},
		{ apiKey: apiKey ?? undefined, maxTokens: 4096, disableReasoning: true },
	);
	if (message.stopReason === "error") {
		throw new Error(message.errorMessage ?? "provider error");
	}
	// `length` means the draft hit the token cap: writing a silently truncated
	// AGENTS.md is worse than failing loudly. `aborted` is not a draft either.
	if (message.stopReason === "length") {
		throw new Error("the draft hit the token cap and would have been truncated");
	}
	if (message.stopReason === "aborted") {
		throw new Error("generation was aborted");
	}
	return stripFencedDraft(
		message.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("\n")
			.trim(),
	);
}

/** Models love wrapping whole generated files in a code fence; peel it. */
function stripFencedDraft(text: string): string {
	const fence = text.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n?```$/);
	return fence ? fence[1]!.trim() : text;
}

/** Where `/init` writes for the given mode; exported for tests. */
export function resolveInitTarget(personal: boolean, cwd: string): string {
	return personal ? path.join(getAgentDir(), "AGENTS.md") : path.join(cwd, "AGENTS.md");
}

export type InitGenerate = (context: InitContext, runtime: SlashCommandRuntime) => Promise<string | undefined>;

export interface InitDeps {
	generate?: InitGenerate;
}

export async function handleInit(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
	deps: InitDeps = {},
): Promise<SlashCommandResult> {
	const args = command.args.trim().split(/\s+/).filter(Boolean);
	const flags = new Set(args.filter(a => a.startsWith("--")));
	const force = flags.has("--force");
	const personal = flags.has("--personal");
	for (const flag of flags) {
		if (flag !== "--force" && flag !== "--personal") {
			return usage(t("Usage: /init [--personal] [--force]"), runtime);
		}
	}
	if (!runtime.session.model) {
		return usage(t("No model selected — pick one before running /init."), runtime);
	}

	const cwd = runtime.cwd;
	const target = resolveInitTarget(personal, cwd);
	const context = await collectInitContext(cwd);
	// Guard the actual write target: --personal writes the agent-dir AGENTS.md
	// (often hand-written global instructions), not the cwd one, so checking
	// only the workspace file would let /init silently overwrite it.
	const targetExists = await fsp
		.access(target)
		.then(() => true)
		.catch(() => false);
	if (targetExists && !force) {
		return usage(t("AGENTS.md already exists here — rerun with --force to overwrite it."), runtime);
	}
	if (!personal && context.hasExistingClaudeMd) {
		await runtime.output(t("Note: a CLAUDE.md already exists here — both files will be loaded next session."));
	}

	const run = async (): Promise<void> => {
		let content: string | undefined;
		try {
			content = await (deps.generate ?? generateAgentsMd)(context, runtime);
		} catch (error) {
			await runtime.output(t("/init failed: {{err}}", { err: errorMessage(error) }));
			return;
		}
		if (!content || !content.trim()) {
			await runtime.output(t("/init failed: the model returned an empty draft."));
			return;
		}
		try {
			await fsp.writeFile(target, content.endsWith("\n") ? content : `${content}\n`, "utf8");
		} catch (error) {
			await runtime.output(t("/init failed: {{err}}", { err: errorMessage(error) }));
			return;
		}
		await runtime.output(t("Wrote {{path}} — it will be picked up on the next session.", { path: target }));
	};
	// Generation makes an LLM call — background-dispatch under RPC so the
	// serialized command queue stays free (same pattern as /dream and /compact).
	if (runtime.runCommandInBackground) {
		runtime.runCommandInBackground(run);
		return commandConsumed();
	}
	await run();
	return commandConsumed();
}

export const BUILTIN_INIT_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "init",
		icon: "wave",
		description: "Generate a starting AGENTS.md for this repository",
		inlineHint: "[--personal] [--force]",
		allowArgs: true,
		handle: handleInit,
	},
];
