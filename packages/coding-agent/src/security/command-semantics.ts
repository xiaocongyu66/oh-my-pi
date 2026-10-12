/**
 * Command-exit-code semantics, ported from CC's commandSemantics.ts: some
 * commands use nonzero exits for non-error outcomes (grep 1 = no matches,
 * diff 1 = files differ, test 1 = condition false). Interpreting those as
 * failures would spam the model with false errors.
 *
 * Heuristic only — "may get it super wrong; don't depend on this for
 * security".
 */

type CommandSemantic = (exitCode: number, stdout: string, stderr: string) => { isError: boolean; message?: string };

const DEFAULT_SEMANTIC: CommandSemantic = (exitCode, _stdout, _stderr) => ({
	isError: exitCode !== 0,
	message: exitCode !== 0 ? `Command failed with exit code ${exitCode}` : undefined,
});

const COMMAND_SEMANTICS: Map<string, CommandSemantic> = new Map([
	// grep: 0=matches found, 1=no matches, 2+=error
	[
		"grep",
		(exitCode, _stdout, _stderr) => ({
			isError: exitCode >= 2,
			message: exitCode === 1 ? "No matches found" : undefined,
		}),
	],

	// ripgrep has same semantics as grep
	[
		"rg",
		(exitCode, _stdout, _stderr) => ({
			isError: exitCode >= 2,
			message: exitCode === 1 ? "No matches found" : undefined,
		}),
	],

	// find: 0=success, 1=partial success (some dirs inaccessible), 2+=error
	[
		"find",
		(exitCode, _stdout, _stderr) => ({
			isError: exitCode >= 2,
			message: exitCode === 1 ? "Some directories were inaccessible" : undefined,
		}),
	],

	// diff: 0=no differences, 1=differences found, 2+=error
	[
		"diff",
		(exitCode, _stdout, _stderr) => ({
			isError: exitCode >= 2,
			message: exitCode === 1 ? "Files differ" : undefined,
		}),
	],

	// test/[: 0=condition true, 1=condition false, 2+=error
	[
		"test",
		(exitCode, _stdout, _stderr) => ({
			isError: exitCode >= 2,
			message: exitCode === 1 ? "Condition is false" : undefined,
		}),
	],

	// [ is an alias for test
	[
		"[",
		(exitCode, _stdout, _stderr) => ({
			isError: exitCode >= 2,
			message: exitCode === 1 ? "Condition is false" : undefined,
		}),
	],
]);

function extractBaseCommand(command: string): string {
	return command.trim().split(/\s+/)[0] || "";
}

/**
 * Extract the primary command from a complex command line. With an && list,
 * the syntactically last command may never have run (`cd /missing && rg
 * needle .` exits 1 from cd) — fall back to the conservative default there.
 * Pipes are safe: without pipefail the last command determines the aggregate
 * status and is always executed.
 */
function heuristicallyExtractBaseCommand(command: string): string {
	if (command.includes("&&")) return "";
	const segments = command
		.split(/[;|\n]|&(?![&])/)
		.map(part => part.trim())
		.filter(part => part.length > 0);
	const lastCommand = segments[segments.length - 1] || command;
	return extractBaseCommand(lastCommand);
}

/**
 * Interpret command result based on semantic rules.
 */
export function interpretCommandResult(
	command: string,
	exitCode: number,
	stdout: string,
	stderr: string,
): {
	isError: boolean;
	message?: string;
} {
	const baseCommand = heuristicallyExtractBaseCommand(command);
	const semantic = COMMAND_SEMANTICS.get(baseCommand) ?? DEFAULT_SEMANTIC;
	return semantic(exitCode, stdout, stderr);
}
