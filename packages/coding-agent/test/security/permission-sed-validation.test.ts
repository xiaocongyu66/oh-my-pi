/**
 * Contract: the ported Claude Code sed constraint checker
 * (sed-validation.ts, checkSedConstraints) asks for in-place edits (-i/-I),
 * file-writing (w/W) and command-executing (e/E) sed operations, and passes
 * safe stdout substitutions, -n line-print scripts, and -e/--expression
 * transports. Segments are tokenized exactly as the host session will.
 */
import { describe, expect, test } from "bun:test";
import { tokenizeShellSegments } from "../../src/tools/shell-tokenize";
import { checkSedConstraints } from "../../src/security/sed-validation";

function check(segment: string) {
	const [tokens] = tokenizeShellSegments(segment);
	return checkSedConstraints(tokens ?? [], segment);
}

describe("checkSedConstraints", () => {
	describe("asks", () => {
		test("in-place edit with -i asks", () => {
			const result = check("sed -i s/a/b/g file.txt");
			expect(result.behavior).toBe("ask");
			expect(result.message).toContain("requires approval");
			expect(result.decisionReason?.type).toBe("other");
			expect(result.decisionReason?.reason).toContain("require explicit approval");
		});

		test("in-place edits with -I and --in-place ask", () => {
			expect(check("sed -I s/a/b/g file.txt").behavior).toBe("ask");
			expect(check("sed --in-place s/a/b/g file.txt").behavior).toBe("ask");
		});

		test("w file-write flag asks", () => {
			expect(check("sed s/a/b/w out.txt").behavior).toBe("ask");
			expect(check("sed 's/a/b/w out.txt'").behavior).toBe("ask");
		});

		test("s///e execute flag asks (n; ... e style)", () => {
			expect(check("sed 'n; s/../../e' file.txt").behavior).toBe("ask");
			expect(check("sed 's/a/b/e' file.txt").behavior).toBe("ask");
		});

		test("bare e execute command asks", () => {
			expect(check("sed 'e id' file.txt").behavior).toBe("ask");
		});

		test("non-sed segment passes through untouched", () => {
			expect(check("echo sed -i s/a/b/g file.txt").behavior).toBe("passthrough");
		});
	});

	describe("passthrough", () => {
		test("plain stdout substitution with file arguments passes", () => {
			const result = check("sed s/a/b/g file.txt");
			expect(result.behavior).toBe("passthrough");
		});

		test("-n print-only invocations pass", () => {
			expect(check("sed -n '1p' file.txt").behavior).toBe("passthrough");
			expect(check("sed -n '1,5p;10p' -E file.txt").behavior).toBe("passthrough");
		});

		test("--expression= form passes (non-destructive)", () => {
			const result = check("sed --expression=s/a/b/ file.txt");
			expect(result.behavior).toBe("passthrough");
		});
	});

	describe("allowFileWrites (CC acceptEdits wiring)", () => {
		test("permits -i substitutions", () => {
			const [tokens] = tokenizeShellSegments("sed -i s/a/b/g file.txt");
			const result = checkSedConstraints(tokens ?? [], "sed -i s/a/b/g file.txt", { allowFileWrites: true });
			expect(result.behavior).toBe("passthrough");
		});

		test("still blocks e operations", () => {
			const [tokens] = tokenizeShellSegments("sed 's/a/b/e' file.txt");
			const result = checkSedConstraints(tokens ?? [], "sed 's/a/b/e' file.txt", { allowFileWrites: true });
			expect(result.behavior).toBe("ask");
		});
	});
});
