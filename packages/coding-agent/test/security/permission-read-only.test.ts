import { describe, expect, test } from "bun:test";
import { checkReadOnlyConstraints } from "../../src/security/read-only";

/** The heuristics (bashSecurity) are injected as always-passthrough here. */
const passthroughSafe = () => ({ behavior: "passthrough" });

function check(command: string, opts?: Partial<Parameters<typeof checkReadOnlyConstraints>[1]>) {
	return checkReadOnlyConstraints(command, {
		isCommandSafe: passthroughSafe,
		compoundCommandHasCd: false,
		...opts,
	});
}

describe("checkReadOnlyConstraints", () => {
	test("allows git status", () => {
		expect(check("git status").behavior).toBe("allow");
	});

	test("allows git diff HEAD", () => {
		expect(check("git diff HEAD").behavior).toBe("allow");
	});

	test("does not allow git -c a=b status (inline config)", () => {
		expect(check("git -c a=b status").behavior).toBe("passthrough");
	});

	test("allows ls", () => {
		expect(check("ls").behavior).toBe("allow");
	});

	test("does not allow ls $(rm -rf /) (command substitution)", () => {
		expect(check("ls $(rm -rf /)").behavior).toBe("passthrough");
	});

	test("does not allow cat file > out (output redirection)", () => {
		expect(check("cat file > out").behavior).toBe("passthrough");
	});

	test("allows grep -r", () => {
		expect(check("grep -r").behavior).toBe("allow");
	});

	test("does not allow find . -delete", () => {
		expect(check("find . -delete").behavior).toBe("passthrough");
	});

	test("allows git log --oneline", () => {
		expect(check("git log --oneline").behavior).toBe("allow");
	});

	test("allows docker ps", () => {
		expect(check("docker ps").behavior).toBe("allow");
	});

	test("does not allow sudo ls", () => {
		expect(check("sudo ls").behavior).toBe("passthrough");
	});

	test("allows echo hi", () => {
		expect(check("echo hi").behavior).toBe("allow");
	});

	test("does not allow echo a | sh (pipe to shell)", () => {
		expect(check("echo a | sh").behavior).toBe("passthrough");
	});

	test("allows ls 2>&1 (stripped stderr redirection)", () => {
		expect(check("ls 2>&1").behavior).toBe("allow");
	});

	test("allows quoted operator inside echo argument", () => {
		expect(check('echo "a && b"').behavior).toBe("allow");
	});

	test("compound cd + git is not auto-allowed", () => {
		expect(check("cd /tmp && git status", { compoundCommandHasCd: true }).behavior).toBe("passthrough");
	});

	test("git in bare repo directory is not auto-allowed", () => {
		expect(check("git status", { isCurrentDirBareRepo: true }).behavior).toBe("passthrough");
	});

	test("git after writing git-internal path is not auto-allowed", () => {
		expect(check("touch hooks/pre-commit && git status").behavior).toBe("passthrough");
	});

	test("non-passthrough injected safety check blocks read-only fast path", () => {
		const result = checkReadOnlyConstraints("ls", {
			isCommandSafe: () => ({ behavior: "ask" }),
			compoundCommandHasCd: false,
		});
		expect(result.behavior).toBe("passthrough");
	});
});
