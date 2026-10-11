/**
 * Adversarial quoting tests for the shell tokenizer and the bash path engine.
 *
 * Claude Code replaced shell-quote with tree-sitter because of known misparses:
 * a single-quote backslash bug that silently merges redirect operators into
 * garbled tokens, quote characters inside comments desyncing the parse, and
 * unquoted brace expansion rewriting the command shape. The security invariant
 * under test: a redirect target outside the working directories must produce
 * "ask" in default mode no matter how the command is quoted or how tightly the
 * operator is glued to adjacent words.
 *
 * Verdicts per category are recorded inline: "fixed" means the engine missed
 * the redirect before the tokenizer emitted standalone operator tokens;
 * "documented" marks deliberate false positives (asks where bash would not
 * write) that are kept because the safe direction is to over-ask.
 */
import { describe, expect, test } from "bun:test";
import { Settings } from "../../src/config/settings";
import { tokenizeShellSegments } from "../../src/tools/shell-tokenize";
import { bashToolCheckPermission } from "../../src/security/bash-check";
import { EMPTY_RULES } from "../../src/security/core/rulesLoader";
import type { PermissionCheckContext } from "../../src/security/core/types";

// Pin the process-wide settings singleton so flag reads (read-only
// auto-allow) behave identically whether this file runs alone or in a
// combined suite where another file initialized settings first.
// Idempotent: returns the existing singleton when another test module
// initialized it first.
await Settings.init({});

function ctx(mode: PermissionCheckContext["mode"] = "default"): PermissionCheckContext {
	return {
		mode,
		rules: EMPTY_RULES,
		workingDirectories: new Map(),
		isInteractive: true,
		isBypassPermissionsModeAvailable: false,
	};
}

function behavior(command: string, mode: PermissionCheckContext["mode"] = "default"): string {
	return bashToolCheckPermission("bash", { command }, ctx(mode)).behavior;
}

describe("redirect operators hidden by quoting", () => {
	test("single-quote backslash bug class: 'a\\'>/target still asks", () => {
		// bash: `'a\'` is the word a\ (backslash literal), then > redirects.
		// shell-quote's `\'` escape misparsing used to merge `>` into one token.
		const command = "echo 'a\\\\'>/etc/omp-adv-q1";
		expect(tokenizeShellSegments(command)[0]).toContain(">");
		expect(tokenizeShellSegments(command)[0]).toContain("/etc/omp-adv-q1");
		expect(behavior(command)).toBe("ask"); // fixed: was passthrough
		expect(behavior("echo 'abc\\\\' >/etc/omp-adv-q1")).toBe("ask");
		expect(behavior("echo 'a\\\\'>>/etc/omp-adv-q1")).toBe("ask");
	});

	test("unterminated-quote variant is caught by the single-quote-bug misparse gate", () => {
		// `echo 'a\'>file'` leaves the final quote unterminated: bash errors out
		// before executing. The odd trailing backslash inside the single-quoted
		// run trips the hasShellQuoteSingleQuoteBug misparsing check, which asks
		// early — the conservative CC-parity posture for ambiguous quoting.
		expect(behavior("echo 'a\\'>file'")).toBe("ask");
	});

	test("double quotes glued to the operator", () => {
		const command = 'echo "a">/etc/omp-adv-q2';
		expect(tokenizeShellSegments(command)[0]).toEqual(["echo", "a", ">", "/etc/omp-adv-q2"]);
		expect(behavior(command)).toBe("ask"); // fixed: was passthrough
		expect(behavior('echo "a" > /etc/omp-adv-q2')).toBe("ask");
	});

	test("dollar-quotes (ANSI-C $'…') glued to the operator", () => {
		const command = "echo $'a'>/etc/omp-adv-q3";
		expect(tokenizeShellSegments(command)[0]).toEqual(["echo", "$a", ">", "/etc/omp-adv-q3"]);
		expect(behavior(command)).toBe("ask");
	});

	test("word-glued operator with no quotes at all", () => {
		const command = "echo hi>/etc/omp-adv-q4";
		expect(tokenizeShellSegments(command)[0]).toEqual(["echo", "hi", ">", "/etc/omp-adv-q4"]);
		expect(behavior(command)).toBe("ask"); // fixed: was passthrough
		expect(behavior("echo hi >>/etc/omp-adv-q4")).toBe("ask");
	});

	test("quoted operator words are not mistaken for redirects (no false positive)", () => {
		// A quoted '>' as DATA must not produce a redirect ASK. Whether the
		// command then lands on the CC step-7 read-only allow or passes through
		// depends on settings initialization order across the suite — the
		// stable anchor is the absence of an ask.
		expect(behavior("echo 'a>b'")).not.toBe("ask");
		expect(behavior("grep 'a>b' README.md")).not.toBe("ask");
		// …while a backslash-escaped operator keeps its literal value (the
		// token carries no operator); its ask comes from the pre-existing
		// backslash-escape security validator, not the redirect scan.
		expect(tokenizeShellSegments("echo a\\>b")[0]).toEqual(["echo", "a>b"]);
		// A quoted '>' followed by an out-of-cwd word does ask, because the
		// value-only token stream cannot distinguish `'>'` from an operator.
		// Known false positive, kept deliberately: over-asking is the safe
		// direction and requires raw/quoted provenance to fix.
		expect(behavior("echo '>' /etc/omp-adv-q5")).toBe("ask"); // documented
	});
});

describe("redirect operators inside comments", () => {
	test("comment text still feeds the redirect scan (conservative ask)", () => {
		// bash treats `# …` as a comment — no write happens. omp's tokenizer has
		// no comment handling, so the commented operator is scanned and asks.
		// Known false positive, kept deliberately: a tokenizer that stripped
		// comments would need full quote/heredoc desync tracking (CC's
		// COMMENT_QUOTE_DESYNC check exists precisely because that is risky).
		const command = "echo hi # > /etc/omp-adv-c1";
		expect(tokenizeShellSegments(command)[0]).toEqual(["echo", "hi", "#", ">", "/etc/omp-adv-c1"]);
		expect(behavior(command)).toBe("ask"); // documented (false positive, safe direction)
	});

	test("real redirect before the comment still asks", () => {
		expect(behavior("echo hi > /etc/omp-adv-c2 # note")).toBe("ask");
	});
});

describe("unquoted brace expansion", () => {
	test("brace expansion glued to a redirect operator asks", () => {
		// bash: `echo {a,b}>file` expands to `echo a b >file` — the write is real.
		const command = "echo {a,b}>/etc/omp-adv-b1";
		expect(tokenizeShellSegments(command)[0]).toContain(">");
		expect(behavior(command)).toBe("ask"); // fixed (brace validator) + redirect scan backstop
	});

	test("brace range expansions ask before any redirect validation", () => {
		expect(behavior("echo {a..z} > /etc/omp-adv-b2")).toBe("ask");
		expect(behavior("echo {a..z} > omp-adv-local.txt")).toBe("ask");
	});
});

describe("heredoc and herestring operators", () => {
	test("<< is not treated as a redirect target", () => {
		const command = "cat <<EOF\nhello\nEOF";
		expect(tokenizeShellSegments(command)[0]).toEqual(["cat", "<<", "EOF"]);
		expect(behavior(command)).toBe("passthrough");
	});

	test("heredoc body lines are scanned, not executed — in-cwd bodies pass", () => {
		// The body is data, but conservative scanning sees the lines as commands;
		// in-cwd content stays passthrough, so no false prompt for plain heredocs.
		expect(behavior("cat <<'EOF'\nsome data\nmore data\nEOF")).toBe("passthrough");
	});

	test("heredoc with a real output redirect asks", () => {
		expect(behavior("cat << EOF > /etc/omp-adv-h1\nx\nEOF")).toBe("ask");
	});

	test("herestrings (<<<) with redirects ask in both spacings", () => {
		expect(behavior("cat <<< x > /etc/omp-adv-h2")).toBe("ask");
		expect(behavior("cat <<< x >/etc/omp-adv-h2")).toBe("ask"); // fixed: was passthrough
	});
});

describe("fd redirect forms", () => {
	test("2>&1 descriptor duplication is not a file write", () => {
		const command = "echo x 2>&1";
		expect(tokenizeShellSegments(command)[0]).toEqual(["echo", "x", "2>&", "1"]);
		expect(behavior(command)).toBe("passthrough");
	});

	test("2>&1 alongside a real stdout redirect still asks", () => {
		expect(behavior("echo x 2>&1 >/etc/omp-adv-f1")).toBe("ask");
	});

	test("&> (both streams) asks", () => {
		expect(behavior("echo x &>/etc/omp-adv-f2")).toBe("ask"); // fixed: was passthrough
	});

	test("2> stderr redirect asks in fused and spaced forms", () => {
		expect(behavior("echo x 2>/etc/omp-adv-f3")).toBe("ask"); // fixed: was passthrough
		expect(behavior("echo x 2> /etc/omp-adv-f3")).toBe("ask"); // fixed: was passthrough
		expect(behavior("echo x 2>>/etc/omp-adv-f3")).toBe("ask");
	});

	test("bare digit target after &-less operator is a filename, not an fd", () => {
		// `2>3` writes a file named 3 (only `2>&3` duplicates); the relative
		// name resolves inside cwd so no prompt, but the token must not be
		// silently dropped from validation.
		expect(tokenizeShellSegments("echo x 2>3")[0]).toEqual(["echo", "x", "2>", "3"]);
	});

	test("in-cwd redirect targets keep deferring to the mode flow", () => {
		// Default mode prompts for every create/write target (CC parity);
		// acceptEdits auto-allows the in-cwd ones in both spacings.
		expect(behavior("echo hi > omp-adv-out.txt", "acceptEdits")).toBe("passthrough");
		expect(behavior("echo hi >omp-adv-out.txt", "acceptEdits")).toBe("passthrough"); // fixed shape, same verdict
		expect(behavior("echo hi >>omp-adv-out.txt", "acceptEdits")).toBe("passthrough");
	});
});

describe("variable/IFS-glued redirects", () => {
	test("echo$a'b'>target still asks", () => {
		// bash expands $a and splits on IFS; the operator is never part of a word.
		const command = "echo$a'b'>/etc/omp-adv-v1";
		expect(tokenizeShellSegments(command)[0]).toEqual(["echo$ab", ">", "/etc/omp-adv-v1"]);
		expect(behavior(command)).toBe("ask");
	});

	test("variable-glued word plus spaced redirect asks", () => {
		expect(behavior("echo $a'b' >/etc/omp-adv-v2")).toBe("ask");
	});
});

describe("newlines inside quotes vs as command separators", () => {
	test("newline inside single quotes stays inside the word", () => {
		const command = "echo 'a\nb' > /etc/omp-adv-n1";
		expect(tokenizeShellSegments(command)).toEqual([["echo", "a\nb", ">", "/etc/omp-adv-n1"]]);
		expect(behavior(command)).toBe("ask");
		expect(behavior("echo 'a\nb' >/etc/omp-adv-n1")).toBe("ask"); // fixed: was passthrough
	});

	test("quoted newline alone does not prompt", () => {
		// Same environment-dependent allow/passthrough split as above; the
		// stable anchor is the absence of an ask for quoted-newline data.
		expect(behavior("echo 'a\nb'")).not.toBe("ask");
	});

	test("newline as separator: the next command's redirect is scanned", () => {
		expect(behavior("echo one\necho two > /etc/omp-adv-n2")).toBe("ask");
		expect(behavior("echo one; echo two >/etc/omp-adv-n2")).toBe("ask");
		expect(behavior("echo one && echo two > /etc/omp-adv-n2")).toBe("ask");
	});
});

describe("compound and subshell shapes", () => {
	test("redirect after a subshell group asks", () => {
		expect(behavior("(echo hi)>/etc/omp-adv-s1")).toBe("ask");
		expect(behavior("(echo hi) > /etc/omp-adv-s1")).toBe("ask");
	});

	test("chain segments are validated independently", () => {
		expect(behavior("echo ok && echo hi >/etc/omp-adv-s2")).toBe("ask");
		expect(behavior("echo hi >/etc/omp-adv-s2; echo done")).toBe("ask");
	});
});
