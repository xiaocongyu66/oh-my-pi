/**
 * Registry of per-tool content permission checks feeding step 1c of the
 * decision flow. Tools without a registered check fall through as
 * `passthrough`, letting rules and mode decide.
 */

import type { PermissionCheckContext, PermissionResult, ToolPermissionCheck } from "./core/types";

const checks = new Map<string, ToolPermissionCheck>();

/** Register (or replace) the content check for a tool. */
export function registerToolCheck(toolName: string, check: ToolPermissionCheck): void {
	checks.set(toolName, check);
}

export function hasToolCheck(toolName: string): boolean {
	return checks.has(toolName);
}

/** Context `checkTool` implementation: dispatch to the registered check. */
export const runToolChecks: ToolPermissionCheck = (
	toolName: string,
	input: Record<string, unknown>,
	ctx: PermissionCheckContext,
): PermissionResult | Promise<PermissionResult> => {
	const check = checks.get(toolName);
	if (!check) {
		return { behavior: "passthrough", message: `Permission requested to use ${toolName}.` };
	}
	return check(toolName, input, ctx);
};
