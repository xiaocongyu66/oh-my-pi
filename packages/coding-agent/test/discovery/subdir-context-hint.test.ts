import { describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendSubdirContextHint, subdirContextHint } from "../../src/discovery/subdir-context-hint";

async function makeWorkspace(): Promise<string> {
	return fsp.mkdtemp(path.join(os.tmpdir(), "omp-subdir-hint-"));
}

describe("subdirContextHint", () => {
	it("hints once for a directory with CLAUDE.md, then dedupes", async () => {
		const cwd = await makeWorkspace();
		const dir = path.join(cwd, "packages", "web");
		await fsp.mkdir(dir, { recursive: true });
		await fsp.writeFile(path.join(dir, "CLAUDE.md"), "# subdir rules", "utf8");
		const session = {};

		const first = await subdirContextHint(session, cwd, path.join(dir, "index.ts"));
		const second = await subdirContextHint(session, cwd, path.join(dir, "other.ts"));

		expect(first).toContain(path.join(dir, "CLAUDE.md"));
		expect(second).toBeUndefined();
		await fsp.rm(cwd, { recursive: true, force: true });
	});

	it("falls back to AGENTS.md when CLAUDE.md is absent", async () => {
		const cwd = await makeWorkspace();
		const dir = path.join(cwd, "scripts");
		await fsp.mkdir(dir, { recursive: true });
		await fsp.writeFile(path.join(dir, "AGENTS.md"), "# agents rules", "utf8");

		const hint = await subdirContextHint({}, cwd, path.join(dir, "build.ts"));

		expect(hint).toContain("AGENTS.md");
		await fsp.rm(cwd, { recursive: true, force: true });
	});

	it("negative-caches directories without a context file", async () => {
		const cwd = await makeWorkspace();
		const dir = path.join(cwd, "src");
		await fsp.mkdir(dir, { recursive: true });

		expect(await subdirContextHint({}, cwd, path.join(dir, "a.ts"))).toBeUndefined();
		// Even if the file appears later in the same session, the negative cache
		// keeps the session quiet — matching the once-per-directory semantics.
		await fsp.writeFile(path.join(dir, "CLAUDE.md"), "# late", "utf8");
		expect(await subdirContextHint({}, cwd, path.join(dir, "b.ts"))).toBeUndefined();
		await fsp.rm(cwd, { recursive: true, force: true });
	});

	it("skips hidden directories and paths outside the cwd", async () => {
		const cwd = await makeWorkspace();
		const hidden = path.join(cwd, ".claude", "memory");
		await fsp.mkdir(hidden, { recursive: true });
		await fsp.writeFile(path.join(hidden, "CLAUDE.md"), "x", "utf8");
		const outside = await makeWorkspace();
		await fsp.writeFile(path.join(outside, "CLAUDE.md"), "x", "utf8");

		expect(await subdirContextHint({}, cwd, path.join(hidden, "note.md"))).toBeUndefined();
		expect(
			await subdirContextHint({}, cwd, path.join(cwd, "..", path.basename(outside), "README.md")),
		).toBeUndefined();
		expect(await subdirContextHint({}, cwd, path.join(cwd, "CLAUDE.md"))).toBeUndefined();
		await fsp.rm(cwd, { recursive: true, force: true });
		await fsp.rm(outside, { recursive: true, force: true });
	});
});

describe("appendSubdirContextHint", () => {
	it("appends the bracketed hint to a successful result", async () => {
		const cwd = await makeWorkspace();
		const dir = path.join(cwd, "app");
		await fsp.mkdir(dir, { recursive: true });
		await fsp.writeFile(path.join(dir, "CLAUDE.md"), "x", "utf8");
		const result = { content: [{ type: "text", text: "file contents here" }] };

		await appendSubdirContextHint({}, cwd, path.join(dir, "main.ts"), result);

		expect(result.content![0]!.text).toContain("file contents here");
		expect(result.content![0]!.text).toContain(path.join(dir, "CLAUDE.md"));
		await fsp.rm(cwd, { recursive: true, force: true });
	});

	it("does not touch error results", async () => {
		const cwd = await makeWorkspace();
		const dir = path.join(cwd, "app");
		await fsp.mkdir(dir, { recursive: true });
		await fsp.writeFile(path.join(dir, "CLAUDE.md"), "x", "utf8");
		const result = { isError: true, content: [{ type: "text", text: "boom" }] };

		await appendSubdirContextHint({}, cwd, path.join(dir, "main.ts"), result);

		expect(result.content![0]!.text).toBe("boom");
		await fsp.rm(cwd, { recursive: true, force: true });
	});
});
