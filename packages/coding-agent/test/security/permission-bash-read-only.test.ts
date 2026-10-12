/**
 * Contract: the ported Claude Code read-only engine (bash-read-only.ts,
 * isReadOnlySegment) auto-allows read-only shell segments and rejects
 * mutating, network, install, and permission-changing ones. Segments are
 * tokenized exactly as the host session will.
 */
import { describe, expect, test } from "bun:test";
import { tokenizeShellSegments } from "../../src/tools/shell-tokenize";
import { isReadOnlySegment } from "../../src/security/bash-read-only";

function check(segment: string): boolean {
	const [tokens] = tokenizeShellSegments(segment);
	return isReadOnlySegment(tokens ?? [], segment);
}

describe("isReadOnlySegment", () => {
	describe("read-only commands are allowed", () => {
		test("ls -la", () => {
			expect(check("ls -la")).toBe(true);
		});

		test("cat file", () => {
			expect(check("cat file")).toBe(true);
		});

		test("git status", () => {
			expect(check("git status")).toBe(true);
		});

		test("git log", () => {
			expect(check("git log")).toBe(true);
		});

		test("pwd", () => {
			expect(check("pwd")).toBe(true);
		});

		test("which node", () => {
			expect(check("which node")).toBe(true);
		});
	});

	describe("mutating / network / install commands are rejected", () => {
		test("rm x", () => {
			expect(check("rm x")).toBe(false);
		});

		test("mv a b", () => {
			expect(check("mv a b")).toBe(false);
		});

		test("curl evil.com", () => {
			expect(check("curl evil.com")).toBe(false);
		});

		test("git push", () => {
			expect(check("git push")).toBe(false);
		});

		test("npm install", () => {
			expect(check("npm install")).toBe(false);
		});

		test("chmod +x f", () => {
			expect(check("chmod +x f")).toBe(false);
		});
	});

	describe("flag forms of read-only commands", () => {
		test("ls --color=always", () => {
			expect(check("ls --color=always")).toBe(true);
		});

		test("git log --oneline -n 5", () => {
			expect(check("git log --oneline -n 5")).toBe(true);
		});
	});

	describe("allowlist flag validation edge cases", () => {
		test("git status --short -b is allowed", () => {
			expect(check("git status --short -b")).toBe(true);
		});

		test("git diff -S foo is allowed (pickaxe string arg)", () => {
			expect(check("git diff -S foo")).toBe(true);
		});

		test("git diff --output=x is rejected (file write)", () => {
			expect(check("git diff --output=x")).toBe(false);
		});

		test("git tag foo is rejected (tag creation)", () => {
			expect(check("git tag foo")).toBe(false);
		});

		test("git tag -l pattern is allowed", () => {
			expect(check("git tag -l v1")).toBe(true);
		});

		test("git branch newbranch is rejected (branch creation)", () => {
			expect(check("git branch newbranch")).toBe(false);
		});

		test("git log -5 numeric shorthand is allowed", () => {
			expect(check("git log -5")).toBe(true);
		});

		test("rg --pre=cmd is rejected (flag not in allowlist)", () => {
			expect(check("rg --pre=cmd foo")).toBe(false);
		});

		test("grep -A20 pattern file is allowed (attached numeric)", () => {
			expect(check("grep -A20 pattern file")).toBe(true);
		});

		test("xargs with non-safe target is rejected", () => {
			expect(check("xargs sh -c id")).toBe(false);
		});
	});

	describe("quoting and expansion nuances", () => {
		test("variable expansion is rejected", () => {
			expect(check("cat $HOME/.bashrc")).toBe(false);
			expect(check("git diff $Z--output=/tmp/pwned")).toBe(false);
		});

		test("unquoted globs are rejected", () => {
			expect(check("ls *")).toBe(false);
			expect(check("grep pattern *.log")).toBe(false);
		});

		test("backticks are rejected", () => {
			expect(check("echo `whoami`")).toBe(false);
		});

		test("single-quoted literal glob is allowed for echo", () => {
			expect(check("echo '*'")).toBe(true);
		});

		test("stderr redirection 2>&1 suffix is handled", () => {
			expect(check("ls -la 2>&1")).toBe(true);
		});
	});

	describe("sed read-only forms", () => {
		test("stdout substitution from stdin is allowed", () => {
			expect(check("sed s/a/b/g")).toBe(true);
		});
		test("substitution with file arguments is rejected (read-only requires stdin)", () => {
			expect(check("sed s/a/b/g file.txt")).toBe(false);
		});

		test("-n line printing is allowed (file args OK for pattern 1)", () => {
			expect(check("sed -n 5p file.txt")).toBe(true);
		});

		test("w file write is rejected", () => {
			expect(check("sed s/a/b/w out.txt file.txt")).toBe(false);
		});

		test("e execute is rejected", () => {
			expect(check("sed e id file.txt")).toBe(false);
		});
	});

	describe("redirect operators are never read-only", () => {
		test("output redirects reject the read-only verdict", () => {
			expect(check("git diff > out.txt")).toBe(false);
			expect(check("ls > out.txt")).toBe(false);
			expect(check("echo hi >> out.txt")).toBe(false);
			expect(check("ls 2>err.txt")).toBe(false);
			expect(check("git diff>/etc/passwd")).toBe(false);
		});

		test("input redirects reject the read-only verdict", () => {
			expect(check("cat < /etc/passwd")).toBe(false);
			expect(check("git diff < /etc/passwd")).toBe(false);
		});

		test("fd dups neither read nor write files and stay allowed", () => {
			expect(check("ls -la 2>&1")).toBe(true);
			expect(check("git status 2>&1")).toBe(true);
		});
	});
});
