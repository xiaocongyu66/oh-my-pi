import { describe, expect, it } from "bun:test";
import {
	buildClaudeMdDeveloperInstructions,
	buildMemoryLines,
	claudemdMemoryDir,
	DIR_EXISTS_GUIDANCE,
	formatFileSize,
	MAX_ENTRYPOINT_BYTES,
	MAX_ENTRYPOINT_LINES,
	truncateEntrypointContent,
} from "../../src/memory/claudemd-backend/prompts";

describe("truncateEntrypointContent", () => {
	it("passes short content through unchanged", () => {
		const result = truncateEntrypointContent("- [Title](file.md) — hook\n");
		expect(result.wasLineTruncated).toBe(false);
		expect(result.wasByteTruncated).toBe(false);
		expect(result.content).toBe("- [Title](file.md) — hook");
		expect(result.content).not.toContain("WARNING");
	});

	it("line-truncates at 200 lines and names the line cap in the warning footer", () => {
		const lines: string[] = [];
		for (let i = 0; i < MAX_ENTRYPOINT_LINES + 25; i++) {
			lines.push(`- [Entry ${i}](file-${i}.md) — hook`);
		}
		const result = truncateEntrypointContent(lines.join("\n"));
		expect(result.wasLineTruncated).toBe(true);
		expect(result.wasByteTruncated).toBe(false);
		expect(result.content.split("\n")[0]).toBe("- [Entry 0](file-0.md) — hook");
		expect(result.content).toContain(`> WARNING: MEMORY.md is ${MAX_ENTRYPOINT_LINES + 25} lines (limit: ${MAX_ENTRYPOINT_LINES}).`);
		expect(result.content).toContain("Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.");
	});

	it("byte-truncates long-line indexes and names the byte cap in the warning footer", () => {
		// One long line under the line cap but over the byte cap.
		const raw = `- [Long](${"x".repeat(MAX_ENTRYPOINT_BYTES + 500)}.md) — hook`;
		const result = truncateEntrypointContent(raw);
		expect(result.wasLineTruncated).toBe(false);
		expect(result.wasByteTruncated).toBe(true);
		expect(result.content.length).toBeLessThan(raw.length);
		expect(result.content).toContain(
			`> WARNING: MEMORY.md is ${formatFileSize(raw.trim().length)} (limit: ${formatFileSize(MAX_ENTRYPOINT_BYTES)}) — index entries are too long.`,
		);
	});

	it("byte-truncates at the last newline, never mid-line", () => {
		const lineA = `- [A](${ "a".repeat(200) }.md) — hook`;
		const lineB = `- [B](${ "b".repeat(200) }.md) — hook`;
		const longLines: string[] = [lineA];
		for (let i = 0; i < 300; i++) longLines.push(lineB);
		const result = truncateEntrypointContent(longLines.join("\n"));
		// The truncated body (before the warning footer) must end at a line boundary.
		const body = result.content.split("\n\n> WARNING")[0]!;
		expect(body.endsWith(lineB)).toBe(true);
		expect(result.wasLineTruncated).toBe(true);
		expect(result.wasByteTruncated).toBe(true);
		// Both caps → combined reason.
		expect(result.content).toContain(`is ${result.lineCount} lines and ${formatFileSize(result.byteCount)}`);
	});
});

describe("buildClaudeMdDeveloperInstructions", () => {
	const memoryDir = claudemdMemoryDir("/tmp/agent");

	it("includes all instruction sections", () => {
		const prompt = buildClaudeMdDeveloperInstructions(memoryDir, "");
		expect(prompt).toContain(`# auto memory`);
		expect(prompt).toContain(`You have a persistent, file-based memory system at \`${memoryDir}\`.`);
		// Types section (verbatim, individual-only variant).
		expect(prompt).toContain("## Types of memory");
		expect(prompt).toContain("<name>user</name>");
		expect(prompt).toContain("<name>feedback</name>");
		expect(prompt).toContain("<name>project</name>");
		expect(prompt).toContain("<name>reference</name>");
		expect(prompt).not.toContain("<scope>"); // TEAMMEM combined variant stripped
		// What-not-to-save section.
		expect(prompt).toContain("## What NOT to save in memory");
		expect(prompt).toContain("- Code patterns, conventions, architecture, file paths, or project structure");
		// How-to-save two-step section.
		expect(prompt).toContain("## How to save memories");
		expect(prompt).toContain("Saving a memory is a two-step process:");
		expect(prompt).toContain("**Step 1** — write the memory to its own file");
		expect(prompt).toContain("**Step 2** — add a pointer to that file in `MEMORY.md`");
		expect(prompt).toContain("type: {{user, feedback, project, reference}}");
		// When-to-access section.
		expect(prompt).toContain("## When to access memories");
		expect(prompt).toContain("- You MUST access memory when the user explicitly asks you to check, recall, or remember.");
		expect(prompt).toContain("- If the user says to *ignore* or *not use* memory: proceed as if MEMORY.md were empty.");
		// Trusting-recall section (eval-tuned header wording).
		expect(prompt).toContain("## Before recommending from memory");
		expect(prompt).toContain('"The memory says X exists" is not the same as "X exists now."');
		// Persistence paragraph.
		expect(prompt).toContain("## Memory and other forms of persistence");
		expect(prompt).toContain("- When to use or update a plan instead of memory:");
		expect(prompt).toContain("- When to use or update tasks instead of memory:");
	});

	it("names the memory dir with DIR_EXISTS_GUIDANCE adapted to this agent's tools", () => {
		const prompt = buildClaudeMdDeveloperInstructions(memoryDir, "");
		expect(prompt).toContain(DIR_EXISTS_GUIDANCE);
		expect(DIR_EXISTS_GUIDANCE).toContain("Write/Edit tools");
		expect(DIR_EXISTS_GUIDANCE).not.toContain("the Write tool (do not run mkdir");
	});

	it("emits the empty-entrypoint line when MEMORY.md is blank", () => {
		const prompt = buildClaudeMdDeveloperInstructions(memoryDir, "");
		expect(prompt).toContain("Your MEMORY.md is currently empty. When you save new memories, they will appear here.");
	});

	it("appends entrypoint content under the MEMORY.md heading", () => {
		const prompt = buildClaudeMdDeveloperInstructions(memoryDir, "- [User role](user_role.md) — who they are");
		expect(prompt).toContain("## MEMORY.md");
		expect(prompt).toContain("- [User role](user_role.md) — who they are");
		expect(prompt).not.toContain("currently empty");
	});

	it("appends the truncation warning when the entrypoint exceeds a cap", () => {
		const lines: string[] = [];
		for (let i = 0; i < MAX_ENTRYPOINT_LINES + 1; i++) lines.push(`- entry ${i}`);
		const prompt = buildClaudeMdDeveloperInstructions(memoryDir, lines.join("\n"));
		expect(prompt).toContain("## MEMORY.md");
		expect(prompt).toContain("> WARNING: MEMORY.md is");
		expect(prompt).not.toContain("- entry 200");
	});
});

describe("buildMemoryLines", () => {
	it("lists memory dir guidance and persistence ordering", () => {
		const lines = buildMemoryLines("auto memory", "/mem");
		const joined = lines.join("\n");
		const typeIdx = joined.indexOf("## Types of memory");
		const whatNotIdx = joined.indexOf("## What NOT to save in memory");
		const howToIdx = joined.indexOf("## How to save memories");
		const whenIdx = joined.indexOf("## When to access memories");
		const trustIdx = joined.indexOf("## Before recommending from memory");
		const persistIdx = joined.indexOf("## Memory and other forms of persistence");
		expect(typeIdx).toBeGreaterThan(-1);
		expect(whatNotIdx).toBeGreaterThan(typeIdx);
		expect(howToIdx).toBeGreaterThan(whatNotIdx);
		expect(whenIdx).toBeGreaterThan(howToIdx);
		expect(trustIdx).toBeGreaterThan(whenIdx);
		expect(persistIdx).toBeGreaterThan(trustIdx);
	});
});
