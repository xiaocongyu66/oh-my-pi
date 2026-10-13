import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { __resetDirsFromEnvForTests, getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import {
	collectInitContext,
	handleInit,
	resolveInitTarget,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-init";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

function createRuntime(cwd: string, withModel = true) {
	const output: string[] = [];
	const runtime = {
		session: {
			model: withModel ? { id: "test-model" } : null,
			modelRegistry: { getApiKey: async () => "key" },
			sessionId: "test-session",
		},
		cwd,
		output: async (text: string) => {
			output.push(text);
		},
	} as unknown as SlashCommandRuntime;
	return { runtime, output };
}

const fakeGenerate = async () => "# Generated agents file\nBuild with bun.";

describe("handleInit", () => {
	it("writes AGENTS.md with a trailing newline and reports the path", async () => {
		const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-init-"));
		const { runtime, output } = createRuntime(cwd);

		const result = await handleInit({ name: "init", args: "", text: "/init" } as never, runtime, {
			generate: fakeGenerate,
		});

		const written = fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8");
		expect(written).toBe("# Generated agents file\nBuild with bun.\n");
		expect(output.join("\n")).toContain("AGENTS.md");
		expect(result).toEqual({ consumed: true });
	});

	it("refuses to overwrite an existing AGENTS.md without --force", async () => {
		const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-init-"));
		fs.writeFileSync(path.join(cwd, "AGENTS.md"), "# existing", "utf8");
		const { runtime } = createRuntime(cwd);

		await handleInit({ name: "init", args: "", text: "/init" } as never, runtime, { generate: fakeGenerate });

		expect(fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8")).toBe("# existing");
	});

	it("--force overwrites an existing AGENTS.md", async () => {
		const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-init-"));
		fs.writeFileSync(path.join(cwd, "AGENTS.md"), "# existing", "utf8");
		const { runtime } = createRuntime(cwd);

		await handleInit({ name: "init", args: "--force", text: "/init --force" } as never, runtime, {
			generate: fakeGenerate,
		});

		expect(fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8")).toContain("Generated agents file");
	});

	it("rejects unknown flags with usage", async () => {
		const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-init-"));
		const { runtime, output } = createRuntime(cwd);

		const result = await handleInit({ name: "init", args: "--bogus", text: "/init --bogus" } as never, runtime, {
			generate: fakeGenerate,
		});

		expect(output.join("\n")).toContain("--force");
		expect(result).toEqual({ consumed: true });
		expect(fs.existsSync(path.join(cwd, "AGENTS.md"))).toBe(false);
	});

	it("--personal guards the agent-dir AGENTS.md, not the cwd one", async () => {
		const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-init-personal-"));
		const personalDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-init-personal-agent-"));
		setAgentDir(personalDir);
		fs.writeFileSync(path.join(personalDir, "AGENTS.md"), "# hand-written global instructions", "utf8");
		const { runtime } = createRuntime(cwd);

		try {
			await handleInit({ name: "init", args: "--personal", text: "/init --personal" } as never, runtime, {
				generate: fakeGenerate,
			});

			expect(fs.readFileSync(path.join(personalDir, "AGENTS.md"), "utf8")).toBe(
				"# hand-written global instructions",
			);
			expect(fs.existsSync(path.join(cwd, "AGENTS.md"))).toBe(false);
		} finally {
			__resetDirsFromEnvForTests();
			await fs.promises.rm(personalDir, { recursive: true, force: true });
		}
	});

	it("refuses to run without a selected model", async () => {
		const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-init-"));
		const { runtime, output } = createRuntime(cwd, false);

		await handleInit({ name: "init", args: "", text: "/init" } as never, runtime, { generate: fakeGenerate });

		// Locale-stable: the refusal message is emitted, nothing is written.
		expect(output.length).toBeGreaterThan(0);
		expect(fs.existsSync(path.join(cwd, "AGENTS.md"))).toBe(false);
	});

	it("writes nothing when generation throws", async () => {
		const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-init-"));
		const { runtime, output } = createRuntime(cwd);

		await handleInit({ name: "init", args: "", text: "/init" } as never, runtime, {
			generate: async () => {
				throw new Error("provider down");
			},
		});

		expect(output.join("\n")).toContain("provider down");
		expect(fs.existsSync(path.join(cwd, "AGENTS.md"))).toBe(false);
	});

	it("writes nothing when the model returns an empty draft", async () => {
		const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-init-"));
		const { runtime } = createRuntime(cwd);

		await handleInit({ name: "init", args: "", text: "/init" } as never, runtime, {
			generate: async () => "   ",
		});

		expect(fs.existsSync(path.join(cwd, "AGENTS.md"))).toBe(false);
	});
});

describe("resolveInitTarget", () => {
	it("points --personal at the agent dir and default at the cwd", () => {
		const cwd = "/tmp/some-project";
		expect(resolveInitTarget(false, cwd)).toBe(path.join(cwd, "AGENTS.md"));
		expect(resolveInitTarget(true, cwd)).toBe(path.join(getAgentDir(), "AGENTS.md"));
	});
});

describe("collectInitContext", () => {
	it("detects build files and existing instruction files, skipping excluded dirs", async () => {
		const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-init-ctx-"));
		fs.writeFileSync(
			path.join(cwd, "package.json"),
			JSON.stringify({ name: "demo", scripts: { test: "bun test" } }),
			"utf8",
		);
		fs.writeFileSync(path.join(cwd, "README.md"), "# Demo\n\nA demo project.", "utf8");
		fs.writeFileSync(path.join(cwd, "AGENTS.md"), "# existing agents", "utf8");
		fs.mkdirSync(path.join(cwd, "node_modules", "dep"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "node_modules", "dep", "index.js"), "", "utf8");

		const context = await collectInitContext(cwd);

		expect(context.buildFiles).toContain("package.json");
		expect(context.buildFiles).not.toContain("Cargo.toml");
		expect(context.hasExistingAgentsMd).toBe(true);
		expect(context.hasExistingClaudeMd).toBe(false);
		expect(context.packageJson).toContain("bun test");
		expect(context.readmeExcerpt).toContain("A demo project.");
		expect(context.directoryTree).not.toContain("node_modules");
	});
});
