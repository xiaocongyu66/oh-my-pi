/**
 * Tests for the tree-sitter bash AST extraction surface (CC's
 * astSubcommands/astRedirects port, src/security/bash-ast.ts) and its additive
 * wiring into bash-check's path constraints.
 *
 * The security invariant: the AST path must agree with the fixed tokenizer on
 * the adversarial redirect matrix (a target the tokenizer surfaces must also
 * surface in the AST), and the AST must never throw into the permission path —
 * malformed input yields null or an empty extraction, so callers fall back to
 * the tokenizer (CC's legacy/shadow mode).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import {
	BASH_AST_MAX_COMMAND_CHARS,
	ensureBashAstLoaded,
	parseBashAst,
	parseBashAstSync,
	type BashAstRedirect,
} from "../../src/security/bash-ast";
import { bashToolCheckPermission } from "../../src/security/bash-check";
import { EMPTY_RULES } from "../../src/security/core/rulesLoader";
import { tokenizeShellSegments } from "../../src/tools/shell-tokenize";
import type { PermissionCheckContext } from "../../src/security/core/types";

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

beforeAll(async () => {
	expect(await ensureBashAstLoaded()).toBe(true);
});

/** Write redirect targets as the fixed tokenizer scan sees them (bash-check's private scan). */
const REDIRECT_WRITE_OP_RE = /^\d*>+[&|]?$|^\d*<>$/u;
function tokenScanTargets(command: string): string[] {
	const targets: string[] = [];
	for (const tokens of tokenizeShellSegments(command)) {
		for (let i = 0; i < tokens.length; i++) {
			if (!REDIRECT_WRITE_OP_RE.test(tokens[i])) continue;
			const target = tokens[i + 1];
			if (!target || target.startsWith("&")) continue;
			if (tokens[i].includes("&") && /^\d+$/.test(target)) continue;
			targets.push(target);
		}
	}
	return targets;
}

/** Write redirect targets as the AST sees them (same skips as the bash-check wiring). */
function astWriteTargets(redirects: BashAstRedirect[]): string[] {
	return redirects
		.filter(r => r.op.includes(">") && r.target.length > 0)
		.filter(r => !(r.op.includes("&") && /^\d+$/.test(r.target)))
		.filter(r => r.target !== "/dev/null")
		.map(r => r.target);
}

describe("bash ast extraction", () => {
	test("glued redirects extract op/target/quoted from the grammar", async () => {
		const parse = await parseBashAst("echo hi>/etc/omp-ast-1");
		expect(parse?.available).toBe(true);
		expect(parse?.redirects).toEqual([{ op: ">", target: "/etc/omp-ast-1", quoted: false }]);
		expect(parse?.subcommands).toEqual(["echo hi"]);
	});

	test("fd prefixes compose into the op; fd dups resolve to their digit target", async () => {
		const parse = await parseBashAst("echo x 2>>/etc/omp-ast-2 2>&1");
		expect(parse?.redirects).toEqual([
			{ op: "2>>", target: "/etc/omp-ast-2", quoted: false },
			{ op: "2>&", target: "1", quoted: false },
		]);
	});

	test("herestrings are input-only redirects", async () => {
		const parse = await parseBashAst("cat <<< y");
		expect(parse?.redirects).toEqual([{ op: "<<<", target: "y", quoted: false }]);
	});

	test("quoted destinations are quote-stripped and flagged", async () => {
		const parse = await parseBashAst('echo x >"/etc/omp-ast-3"');
		expect(parse?.redirects).toEqual([{ op: ">", target: "/etc/omp-ast-3", quoted: true }]);
	});

	test("append and both-stream operators", async () => {
		const parse = await parseBashAst("echo x &>>/etc/omp-ast-4 >/etc/omp-ast-5");
		expect(parse?.redirects).toEqual([
			{ op: "&>>", target: "/etc/omp-ast-4", quoted: false },
			{ op: ">", target: "/etc/omp-ast-5", quoted: false },
		]);
	});

	test("heredoc delimiters are targets with quotes stripped", async () => {
		const parse = await parseBashAst("cat <<'EOF'\nhi\nEOF");
		expect(parse?.redirects).toEqual([{ op: "<<", target: "EOF", quoted: true }]);
		expect(parse?.subcommands).toEqual(["cat"]);
	});

	test("subcommands span pipelines, substitutions, and chains", async () => {
		// The substitution stays inside the grep command's own node text.
		const parse = await parseBashAst("echo ok && rm -rf / | grep x `id`");
		expect(parse?.subcommands).toEqual(["echo ok", "rm -rf /", "grep x `id`", "id"]);
	});

	test("input over the 10k cap returns null (CC parity)", async () => {
		const long = `echo hi >/etc/omp-ast-long ${"x".repeat(BASH_AST_MAX_COMMAND_CHARS)}`;
		expect(long.length).toBeGreaterThan(BASH_AST_MAX_COMMAND_CHARS);
		expect(await parseBashAst(long)).toBeNull();
		expect(parseBashAstSync(long)).toBeNull();
	});
});

describe("bash ast agrees with the fixed tokenizer on the adversarial matrix", () => {
	test("single-quote backslash bug class", async () => {
		const command = "echo 'a\\\\'>/etc/omp-ast-q1";
		expect(tokenScanTargets(command)).toEqual(["/etc/omp-ast-q1"]);
		expect(astWriteTargets((await parseBashAst(command))?.redirects ?? [])).toEqual(["/etc/omp-ast-q1"]);
	});

	test("word-glued, double-quoted, and variable-glued operators", async () => {
		for (const command of [
			"echo hi>/etc/omp-ast-q2",
			'echo "a">/etc/omp-ast-q2',
			"echo $a'b'>/etc/omp-ast-q2",
			"echo {a,b}>/etc/omp-ast-q2",
		]) {
			expect(tokenScanTargets(command)).toEqual(["/etc/omp-ast-q2"], command);
			expect(astWriteTargets((await parseBashAst(command))?.redirects ?? [])).toEqual(["/etc/omp-ast-q2"], command);
		}
	});

	test("&> and 2> in fused and spaced forms", async () => {
		for (const command of [
			"echo x &>/etc/omp-ast-f1",
			"echo x 2>/etc/omp-ast-f1",
			"echo x 2> /etc/omp-ast-f1",
			"echo x 2>>/etc/omp-ast-f1",
			"echo x 2>&1 >/etc/omp-ast-f1",
			"cat <<< x >/etc/omp-ast-f1",
		]) {
			expect(tokenScanTargets(command)).toEqual(["/etc/omp-ast-f1"], command);
			expect(astWriteTargets((await parseBashAst(command))?.redirects ?? [])).toEqual(["/etc/omp-ast-f1"], command);
		}
	});

	test("comment redirects: AST sees none (correct); the token scan FP stays ask", async () => {
		const command = "echo hi # > /etc/omp-ast-c1";
		// bash treats `# …` as a comment — the AST knows no write happens.
		expect(astWriteTargets((await parseBashAst(command))?.redirects ?? [])).toEqual([]);
		// The conservative token scan still flags the commented operator, and it
		// stays wired additively, so the verdict is unchanged (documented FP).
		expect(tokenScanTargets(command)).toEqual(["/etc/omp-ast-c1"]);
		expect(behavior(command)).toBe("ask");
	});

	test("AST extracts the exact target a tokenizer can only mangle (substitutions)", async () => {
		// The tokenizer has no backtick state: the inner redirect surfaces with
		// the closing backtick glued to the target — a different path. The AST
		// resolves the substitution body and extracts the real write target.
		const command = "echo `echo hi > /etc/omp-ast-sub`";
		expect(tokenScanTargets(command)).toEqual(["/etc/omp-ast-sub`"]);
		expect(astWriteTargets((await parseBashAst(command))?.redirects ?? [])).toEqual(["/etc/omp-ast-sub"]);
		// Both surfaces ask (each sees an out-of-cwd write target).
		expect(behavior(command)).toBe("ask");
	});
});

describe("bash ast wiring into checkPathConstraints", () => {
	test("fd dups and /dev/null stay passthrough once the AST is active", async () => {
		expect(behavior("echo x 2>&1")).toBe("passthrough");
		expect(behavior("echo x >&2")).toBe("passthrough");
		expect(behavior("echo x 2>/dev/null")).toBe("passthrough");
		expect(behavior("echo x &>/dev/null")).toBe("passthrough");
		expect(behavior("cat <<EOF\nhello\nEOF")).toBe("passthrough");
	});

	test("in-cwd targets keep deferring to the mode flow", async () => {
		expect(behavior("echo hi > omp-ast-out.txt", "acceptEdits")).toBe("passthrough");
		expect(behavior("echo hi >>omp-ast-out.txt", "acceptEdits")).toBe("passthrough");
	});

	test("bypassPermissions suppresses the AST redirect ask like the token scan", () => {
		expect(behavior("echo hi >/etc/omp-ast-b1", "bypassPermissions")).toBe("passthrough");
	});

	test("sync snapshot agrees with the async API once loaded", async () => {
		const command = "echo hi >/etc/omp-ast-sync";
		expect(parseBashAstSync(command)).toEqual(await parseBashAst(command));
	});
});

describe("bash ast never throws on malformed input", () => {
	const malformed = [
		"'",
		'"',
		">",
		">>",
		"<",
		"2>",
		"&>",
		"1>&",
		"a>",
		"a<",
		"a<>",
		">/etc/omp-ast-m1",
		"echo 'a\\'>file'",
		"echo 'unterminated >/etc/omp-ast-m1",
		'"unterminated >/etc/omp-ast-m1',
		"$((",
		"${",
		"`echo",
		"<<EOF",
		"<<<",
		"(((",
		"((((((",
		"|",
		"&",
		";",
		";|&&",
		"echo ]",
		"echo }{",
		"a\nb\nc",
		"echo \x00\x01\x02",
		"echo \\",
		"\\",
		"echo '`'",
		"`",
		"$",
		"echo ${x:-$(y",
		"if;then;fi",
		"do done",
		"()",
		"((",
		"))",
		"echo x 2>&1 >/dev/null <<",
		"echo $(($(($((",
	];

	test("malformed commands return a parse or null, never throw", async () => {
		for (const command of malformed) {
			let result: unknown;
			expect(() => {
				result = parseBashAstSync(command);
			}).not.toThrow();
			const parse = await parseBashAst(command);
			expect(parse === null || typeof parse === "object").toBe(true, JSON.stringify(command));
			if (parse) {
				expect(parse.available).toBe(true);
				expect(Array.isArray(parse.subcommands)).toBe(true);
				expect(Array.isArray(parse.redirects)).toBe(true);
			}
			if (result !== null) {
				expect(result).toEqual(parse);
			}
		}
	});

	test("adversarial fuzz-ish inputs stay bounded and throw-free", async () => {
		const seeds = [">>", "><", "&&", "|||", "$(", "`'", "'`", "<<<<", "2>&1>&2>&1"];
		for (const seed of seeds) {
			const command = seed.repeat(200);
			const parse = await parseBashAst(command);
			expect(parse === null || typeof parse === "object").toBe(true);
			for (const redirect of parse?.redirects ?? []) {
				expect(typeof redirect.op).toBe("string");
				expect(typeof redirect.target).toBe("string");
				expect(typeof redirect.quoted).toBe("boolean");
			}
		}
	});
});
