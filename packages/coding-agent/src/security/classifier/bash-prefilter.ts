/**
 * Cheap bash pre-screen for the auto-mode classifier, shaped after Claude
 * Code's bash pre-classification hookup (the reconstructed upstream
 * bashClassifier.ts is a stub, so the safe/dangerous command sets are a fresh
 * conservative port aligned with the classifier prompt's BLOCK/ALLOW
 * categories). Read-only commands short-circuit to allow and obviously
 * destructive commands short-circuit to deny without paying for a classifier
 * model call; everything else falls through to the LLM.
 *
 * Both checks are intentionally over-inclusive in the fail-safe direction: a
 * false "dangerous" only forces user confirmation, and a false "unknown" only
 * costs a classifier call. "Safe" requires a single metacharacter-free
 * command from a small read-only allowlist, so shell syntax cannot smuggle an
 * execution past it.
 */

export type BashPrescreen = "safe" | "dangerous" | "unknown";

export type BashPrescreenResult = {
	verdict: BashPrescreen;
	/** Human-readable explanation carried into the ClassifierResult reason. */
	reason: string;
};

/** Read-only commands that never need classification (single command only). */
const SAFE_FIRST_TOKENS = new Set([
	"ls",
	"cat",
	"head",
	"tail",
	"wc",
	"pwd",
	"stat",
	"file",
	"du",
	"df",
	"ps",
	"date",
	"uname",
	"whoami",
	"hostname",
	"id",
	"which",
	"whereis",
	"basename",
	"dirname",
	"realpath",
	"readlink",
	"echo",
	"printf",
	"true",
	"false",
	"diff",
	"grep",
	"rg",
	"sort",
	"tree",
]);

/** Git subcommands that only read local repository state. */
const SAFE_GIT_SUBCOMMANDS = new Set(["status", "log", "diff", "show"]);

/** Any binary whose arguments are only version/help flags is read-only. */
const VERSION_HELP_ONLY = /^(?:--version|--help|-V|-h|-v|-\?)$/;

/** Leading environment assignments (FOO=bar cmd ...) are skipped, not executed. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Shell structure that takes a command out of "definitely safe" territory. */
const UNSAFE_METACHARS = /[|;&<>()`$\n]/;

/** find options that execute commands, delete, or write files. */
const UNSAFE_FIND_OPTION = /^-(?:exec|execdir|ok|okdir|delete|fprintf|fprint|fls)$/;

/**
 * Destructive patterns checked per pipeline segment. Segments are split on
 * shell operators without quote awareness — a quoted operator may produce a
 * spurious segment, but that can only cause a false "dangerous" (fail-safe),
 * never a false "safe" (the safe check rejects metacharacters outright).
 */
const DANGEROUS_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
	{
		pattern: /(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i,
		reason: "Code from External: download piped into a shell",
	},
	{ pattern: /(?:^|\s)(?:sudo|doas)\s/, reason: "Privilege Escalation: sudo/doas" },
	{ pattern: /(?:^|\s)su\s/, reason: "Privilege Escalation: su" },
	{ pattern: /:\(\)\s*\{/, reason: "Fork bomb" },
	{ pattern: /(?:^|\s)mkfs/i, reason: "Irreversible Local Destruction: filesystem format" },
	{ pattern: /\bdd\s[^|;&]*of=\/dev\/(?:sd|nvme|hd|vd)/i, reason: "Irreversible Local Destruction: raw disk write" },
	{ pattern: />\s*\/dev\/(?:sd|nvme|hd|vd)/i, reason: "Irreversible Local Destruction: raw disk write" },
	{ pattern: /\bchmod\b[^|;&]*\b777\b/, reason: "Security Weaken: world-writable permissions" },
	{ pattern: /(?:^|\s)(?:shutdown|reboot|halt|poweroff)\b/, reason: "System power operation" },
	{ pattern: /(?:^|\s)init\s+[06]\b/, reason: "System power operation" },
];

function isRmRecursiveForce(segment: string): boolean {
	const match = /(?:^|\s)rm\s+(.*)/.exec(segment);
	if (!match) {
		return false;
	}
	const args = match[1]!;
	const shortFlags = [...args.matchAll(/(?:^|\s)-([a-zA-Z]+)/g)].flatMap(m => m[1]!.split(""));
	const hasRecursive =
		/(?:^|\s)--recursive(?:\s|$)/.test(args) || shortFlags.includes("r") || shortFlags.includes("R");
	const hasForce = /(?:^|\s)--force(?:\s|$)/.test(args) || shortFlags.includes("f");
	return hasRecursive && hasForce;
}

function isDangerous(command: string): string | null {
	for (const { pattern, reason } of DANGEROUS_PATTERNS) {
		if (pattern.test(command)) {
			return reason;
		}
	}
	for (const segment of command.split(/\|\||&&|[|;\n]/)) {
		if (isRmRecursiveForce(segment)) {
			return "Irreversible Local Destruction: rm with recursive force";
		}
	}
	return null;
}

function isSafe(command: string): boolean {
	const trimmed = command.trim();
	if (trimmed.length === 0 || UNSAFE_METACHARS.test(trimmed)) {
		return false;
	}
	const tokens = trimmed.split(/\s+/);
	let index = 0;
	while (index < tokens.length - 1 && ENV_ASSIGNMENT.test(tokens[index]!)) {
		index += 1;
	}
	const first = tokens[index]!;
	const rest = tokens.slice(index + 1);
	if (first === "git") {
		return rest.length > 0 && SAFE_GIT_SUBCOMMANDS.has(rest[0]!);
	}
	if (first === "find") {
		return rest.length > 0 && !rest.some(token => UNSAFE_FIND_OPTION.test(token));
	}
	if (rest.length > 0 && rest.every(token => VERSION_HELP_ONLY.test(token))) {
		return true;
	}
	return SAFE_FIRST_TOKENS.has(first);
}

/** Run both pre-screen checks and explain the verdict. */
export function prescreenBashCommand(command: string): BashPrescreenResult {
	const dangerousReason = isDangerous(command);
	if (dangerousReason !== null) {
		return { verdict: "dangerous", reason: dangerousReason };
	}
	if (isSafe(command)) {
		return { verdict: "safe", reason: "Command matches the read-only pre-screen allowlist" };
	}
	return { verdict: "unknown", reason: "Command not covered by the bash pre-screen" };
}
