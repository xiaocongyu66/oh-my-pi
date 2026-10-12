/**
 * CC parity for the filesystem-tool permission flow (Edit/Write/NotebookEdit
 * checkPermissions): acceptEdits auto-allows workspace writes and asks
 * outside them (symlink representations included); file creation is not
 * distinguished from updates; NotebookEdit rides the write flow; and every
 * path an edit payload writes — compound renames and freeform patch targets —
 * is permission-checked, folded strictest-first.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkFileToolPermission } from "../../src/security/file-checks";
import { EMPTY_RULES, parsedRulesFromEffective } from "../../src/security/core/rulesLoader";
import type { PermissionCheckContext } from "../../src/security/core/types";

function ctx(overrides: Partial<PermissionCheckContext> = {}, dirs: readonly string[] = []): PermissionCheckContext {
	const workingDirectories = new Map<string, { path: string; source: "project" }>();
	for (const dir of dirs) workingDirectories.set(dir, { path: dir, source: "project" });
	return {
		mode: "default",
		rules: EMPTY_RULES,
		workingDirectories,
		isInteractive: true,
		isBypassPermissionsModeAvailable: false,
		...overrides,
	};
}

function workspace(): string {
	return mkdtempSync(path.join(os.tmpdir(), "omp-fsperm-"));
}

function otherWorkspace(): string {
	return mkdtempSync(path.join(os.tmpdir(), "omp-fsperm-out-"));
}

/** `/tmp/…` → `//tmp/…` for rule patterns rooted at the filesystem root. */
function rootPattern(p: string): string {
	return `//${p.slice(1)}`;
}

describe("CC parity: acceptEdits containment", () => {
	test("acceptEdits auto-allows in-workspace edits and asks out-of-workspace", () => {
		const dir = workspace();
		const out = otherWorkspace();
		const inResult = checkFileToolPermission(
			"edit",
			{ path: path.join(dir, "a.ts") },
			ctx({ mode: "acceptEdits" }, [dir]),
		);
		expect(inResult.behavior).toBe("allow");
		const outResult = checkFileToolPermission(
			"edit",
			{ path: path.join(out, "b.ts") },
			ctx({ mode: "acceptEdits" }, [dir]),
		);
		expect(outResult.behavior).toBe("ask");
		expect("decisionReason" in outResult && outResult.decisionReason?.type).toBe("workingDir");
	});

	test("acceptEdits honors additional working directories", () => {
		const dir = workspace();
		const extra = otherWorkspace();
		const result = checkFileToolPermission(
			"write",
			{ path: path.join(extra, "new.txt"), content: "hi" },
			ctx({ mode: "acceptEdits" }, [dir, extra]),
		);
		expect(result.behavior).toBe("allow");
	});

	test("acceptEdits asks when an in-workspace path symlink-resolves outside", () => {
		const dir = workspace();
		const out = otherWorkspace();
		const secret = path.join(out, "secret.txt");
		writeFileSync(secret, "s");
		const link = path.join(dir, "link.txt");
		symlinkSync(secret, link);
		const result = checkFileToolPermission("edit", { path: link }, ctx({ mode: "acceptEdits" }, [dir]));
		expect(result.behavior).toBe("ask");
		expect("decisionReason" in result && result.decisionReason?.type).toBe("workingDir");
	});
});

describe("CC parity: new-file vs existing-file", () => {
	test("acceptEdits auto-allows creating a new file in-workspace", () => {
		const dir = workspace();
		const result = checkFileToolPermission(
			"write",
			{ path: path.join(dir, "created.txt"), content: "hi" },
			ctx({ mode: "acceptEdits" }, [dir]),
		);
		expect(result.behavior).toBe("allow");
	});

	test("default mode leaves an in-workspace write as an unremarkable ask", () => {
		const dir = workspace();
		const result = checkFileToolPermission("edit", { path: path.join(dir, "a.ts") }, ctx({}, [dir]));
		expect(result.behavior).toBe("ask");
		expect((result as { decisionReason?: unknown }).decisionReason).toBeUndefined();
	});
});

describe("CC parity: NotebookEdit rides the write flow", () => {
	test("acceptEdits auto-allows an in-workspace notebook edit", () => {
		const dir = workspace();
		const result = checkFileToolPermission(
			"notebook_edit",
			{ notebook_path: path.join(dir, "nb.ipynb"), new_source: "x" },
			ctx({ mode: "acceptEdits" }, [dir]),
		);
		expect(result.behavior).toBe("allow");
	});

	test("an out-of-workspace notebook edit asks with the workingDir reason", () => {
		const dir = workspace();
		const out = otherWorkspace();
		const result = checkFileToolPermission(
			"notebook_edit",
			{ notebook_path: path.join(out, "nb.ipynb"), new_source: "x" },
			ctx({ mode: "acceptEdits" }, [dir]),
		);
		expect(result.behavior).toBe("ask");
		expect("decisionReason" in result && result.decisionReason?.type).toBe("workingDir");
	});
});

describe("CC parity: every written path of an edit payload is checked", () => {
	test("compound edit with an out-of-workspace rename destination asks under acceptEdits", () => {
		const dir = workspace();
		const out = otherWorkspace();
		const result = checkFileToolPermission(
			"edit",
			{ path: path.join(dir, "a.ts"), edits: [{ op: "update", rename: path.join(out, "b.ts"), diff: "@@\n" }] },
			ctx({ mode: "acceptEdits" }, [dir]),
		);
		expect(result.behavior).toBe("ask");
		expect("decisionReason" in result && result.decisionReason?.type).toBe("workingDir");
	});

	test("compound edit renaming into a sensitive directory asks with a bypass-immune safetyCheck", () => {
		const dir = workspace();
		const result = checkFileToolPermission(
			"edit",
			{
				path: path.join(dir, "a.ts"),
				edits: [{ op: "update", rename: path.join(dir, ".git", "hooks", "x"), diff: "@@\n" }],
			},
			ctx({ mode: "acceptEdits" }, [dir]),
		);
		expect(result.behavior).toBe("ask");
		expect("decisionReason" in result && result.decisionReason?.type).toBe("safetyCheck");
	});

	test("a deny rule on the rename destination denies the whole payload", () => {
		const dir = workspace();
		const out = otherWorkspace();
		const dest = path.join(out, "b.ts");
		const rules = parsedRulesFromEffective(undefined, [`Edit(${rootPattern(dest)})`]);
		const result = checkFileToolPermission(
			"edit",
			{ path: path.join(dir, "a.ts"), edits: [{ op: "update", rename: dest, diff: "@@\n" }] },
			ctx({ mode: "acceptEdits", rules }, [dir]),
		);
		expect(result.behavior).toBe("deny");
	});

	test("a fully in-workspace compound edit stays allowed under acceptEdits", () => {
		const dir = workspace();
		const result = checkFileToolPermission(
			"edit",
			{ path: path.join(dir, "a.ts"), edits: [{ op: "update", rename: path.join(dir, "b.ts"), diff: "@@\n" }] },
			ctx({ mode: "acceptEdits" }, [dir]),
		);
		expect(result.behavior).toBe("allow");
	});

	test("freeform apply_patch updating a file outside the workspace asks under acceptEdits", () => {
		const dir = workspace();
		const out = otherWorkspace();
		const input = `*** Begin Patch\n*** Update File: ${path.join(out, "x.ts")}\n@@\n-old\n+new\n*** End Patch`;
		const result = checkFileToolPermission("edit", { input }, ctx({ mode: "acceptEdits" }, [dir]));
		expect(result.behavior).toBe("ask");
		expect("decisionReason" in result && result.decisionReason?.type).toBe("workingDir");
	});

	test("apply_patch Move-to destination is permission-checked", () => {
		const dir = workspace();
		const out = otherWorkspace();
		const input = `*** Begin Patch\n*** Update File: ${path.join(dir, "a.ts")}\n*** Move to: ${path.join(out, "b.ts")}\n@@\n-old\n+new\n*** End Patch`;
		const result = checkFileToolPermission("edit", { input }, ctx({ mode: "acceptEdits" }, [dir]));
		expect(result.behavior).toBe("ask");
		expect("decisionReason" in result && result.decisionReason?.type).toBe("workingDir");
	});

	test("hashline MV destination is permission-checked", () => {
		const dir = workspace();
		const out = otherWorkspace();
		const input = `*** Begin Patch\n[${path.join(dir, "a.ts")}#ABCD]\nPUT 1.=1:\n+new\nMV ${path.join(out, "b.ts")}\n*** End Patch`;
		const result = checkFileToolPermission("edit", { input }, ctx({ mode: "acceptEdits" }, [dir]));
		expect(result.behavior).toBe("ask");
		expect("decisionReason" in result && result.decisionReason?.type).toBe("workingDir");
	});

	test("URL-only freeform payload defers to the tool's own tier gate", () => {
		const input = "*** Begin Patch\n*** Update File: session://notes\n*** End Patch";
		const result = checkFileToolPermission("edit", { input }, ctx({ mode: "acceptEdits" }));
		expect(result.behavior).toBe("passthrough");
	});
});

describe("CC parity: bypass-immune outcomes survive the fold", () => {
	test("an in-workspace target cannot mask a safetyCheck on a sibling target", () => {
		const dir = workspace();
		const result = checkFileToolPermission(
			"edit",
			{ path: path.join(dir, ".git", "config"), edits: [{ op: "update", rename: path.join(dir, "b.ts") }] },
			ctx({ mode: "acceptEdits" }, [dir]),
		);
		expect(result.behavior).toBe("ask");
		expect("decisionReason" in result && result.decisionReason?.type).toBe("safetyCheck");
	});

	test("bypassPermissions mode still prompts for a sensitive-file rename via the safety gate", () => {
		const dir = workspace();
		const result = checkFileToolPermission(
			"edit",
			{ path: path.join(dir, "a.ts"), edits: [{ op: "update", rename: path.join(dir, ".bashrc") }] },
			ctx({ mode: "bypassPermissions" }, [dir]),
		);
		expect(result.behavior).toBe("ask");
		expect("decisionReason" in result && result.decisionReason?.type).toBe("safetyCheck");
	});
});
