import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	formatMemoryManifest,
	MAX_MEMORY_FILES,
	parseMemoryFrontmatter,
	scanMemoryFiles,
} from "../../src/memory/claudemd-backend/scan";

let tempDir: string | undefined;

async function makeTempDir(): Promise<string> {
	tempDir = await mkdtemp(path.join(os.tmpdir(), "claudemd-scan-"));
	return tempDir;
}

afterEach(async () => {
	if (tempDir) {
		await rm(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

async function writeMemory(dir: string, filename: string, content: string): Promise<string> {
	const target = path.join(dir, filename);
	await mkdir(path.dirname(target), { recursive: true });
	await writeFile(target, content, "utf8");
	return target;
}

function memoryFileBody(description: string, type?: string): string {
	const lines = ["---", `name: test`, `description: ${description}`];
	if (type !== undefined) lines.push(`type: ${type}`);
	lines.push("---", "", "Some content.", "");
	return lines.join("\n");
}

describe("parseMemoryFrontmatter", () => {
	it("parses name/description/type from a leading frontmatter block", () => {
		const parsed = parseMemoryFrontmatter(memoryFileBody("Deploy runbook for the edge cluster", "project"));
		expect(parsed.description).toBe("Deploy runbook for the edge cluster");
		expect(parsed.type).toBe("project");
	});

	it("returns undefined type for an invalid type value", () => {
		const parsed = parseMemoryFrontmatter(memoryFileBody("desc", "secret"));
		expect(parsed.description).toBe("desc");
		expect(parsed.type).toBeUndefined();
	});

	it("returns undefined type when the field is missing", () => {
		const parsed = parseMemoryFrontmatter("---\nname: x\ndescription: y\n---\n\nbody");
		expect(parsed.description).toBe("y");
		expect(parsed.type).toBeUndefined();
	});

	it("yields no description when frontmatter starts after the 30-line window", () => {
		const padding: string[] = [];
		for (let i = 0; i < 35; i++) padding.push("prose line");
		const parsed = parseMemoryFrontmatter([...padding, "---", "description: late", "type: user", "---"].join("\n"));
		expect(parsed.description).toBeNull();
		expect(parsed.type).toBeUndefined();
	});

	it("yields no description without a frontmatter block", () => {
		const parsed = parseMemoryFrontmatter("just body text");
		expect(parsed.description).toBeNull();
		expect(parsed.type).toBeUndefined();
	});

	it("unquotes quoted values", () => {
		const parsed = parseMemoryFrontmatter("---\ndescription: \"has: colon\"\ntype: 'feedback'\n---");
		expect(parsed.description).toBe("has: colon");
		expect(parsed.type).toBe("feedback");
	});

	it("maps empty description to null", () => {
		const parsed = parseMemoryFrontmatter("---\ndescription:\n---");
		expect(parsed.description).toBeNull();
	});
});

describe("scanMemoryFiles", () => {
	it("finds topic files with descriptions and types, excluding MEMORY.md and non-md files", async () => {
		const dir = await makeTempDir();
		await writeMemory(dir, "MEMORY.md", "- [Index](a.md)");
		await writeMemory(dir, "a.md", memoryFileBody("First file", "user"));
		await writeMemory(dir, "b.md", memoryFileBody("Second file", "reference"));
		await writeMemory(dir, "notes.txt", "not a memory");

		const headers = await scanMemoryFiles(dir);
		const names = headers.map(h => h.filename).sort();
		expect(names).toEqual(["a.md", "b.md"]);
		expect(headers.map(h => h.description).sort()).toEqual(["First file", "Second file"]);
	});

	it("scans nested subdirectories with relative filenames", async () => {
		const dir = await makeTempDir();
		await writeMemory(dir, path.join("sub", "nested.md"), memoryFileBody("Nested", "project"));

		const headers = await scanMemoryFiles(dir);
		expect(headers).toHaveLength(1);
		expect(headers[0]!.filename).toBe(path.join("sub", "nested.md"));
		expect(headers[0]!.filePath).toBe(path.join(dir, "sub", "nested.md"));
	});

	it("sorts newest-first by mtime", async () => {
		const dir = await makeTempDir();
		const oldPath = await writeMemory(dir, "old.md", memoryFileBody("Old"));
		const newPath = await writeMemory(dir, "new.md", memoryFileBody("New"));
		const oldTime = new Date(Date.now() - 86_400_000);
		await utimes(oldPath, oldTime, oldTime);
		await utimes(newPath, new Date(), new Date());

		const headers = await scanMemoryFiles(dir);
		expect(headers.map(h => h.filename)).toEqual(["new.md", "old.md"]);
	});

	it("caps results at MAX_MEMORY_FILES (200)", async () => {
		const dir = await makeTempDir();
		for (let i = 0; i < MAX_MEMORY_FILES + 30; i++) {
			await writeMemory(dir, `f${String(i).padStart(4, "0")}.md`, memoryFileBody(`desc ${i}`));
		}
		const headers = await scanMemoryFiles(dir);
		expect(headers).toHaveLength(MAX_MEMORY_FILES);
	}, 30_000);

	it("returns [] for a missing directory", async () => {
		const headers = await scanMemoryFiles(path.join(await makeTempDir(), "does-not-exist"));
		expect(headers).toEqual([]);
	});
});

describe("formatMemoryManifest", () => {
	it("formats [type] filename (ISO timestamp): description lines", () => {
		const mtime = Date.UTC(2026, 2, 5, 12, 0, 0);
		const manifest = formatMemoryManifest([
			{
				filename: "user_role.md",
				filePath: "/mem/user_role.md",
				mtimeMs: mtime,
				description: "User is a Rust dev",
				type: "user",
			},
		]);
		expect(manifest).toBe("- [user] user_role.md (2026-03-05T12:00:00.000Z): User is a Rust dev");
	});

	it("omits the type tag and description when absent", () => {
		const mtime = Date.UTC(2026, 2, 5, 12, 0, 0);
		const manifest = formatMemoryManifest([
			{ filename: "orphan.md", filePath: "/mem/orphan.md", mtimeMs: mtime, description: null, type: undefined },
		]);
		expect(manifest).toBe("- orphan.md (2026-03-05T12:00:00.000Z)");
	});

	it("formats multiple files one per line", () => {
		const mtime = Date.UTC(2026, 2, 5, 12, 0, 0);
		const manifest = formatMemoryManifest([
			{ filename: "a.md", filePath: "/mem/a.md", mtimeMs: mtime, description: "A", type: "project" },
			{ filename: "b.md", filePath: "/mem/b.md", mtimeMs: mtime, description: null, type: undefined },
		]);
		expect(manifest.split("\n")).toEqual([
			"- [project] a.md (2026-03-05T12:00:00.000Z): A",
			"- b.md (2026-03-05T12:00:00.000Z)",
		]);
	});
});
