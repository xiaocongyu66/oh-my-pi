/**
 * Sandbox auto-allow wiring for the permission decision engine, ported from
 * Claude Code's sandbox auto-allow flow
 * (`bashPermissions.ts` `checkSandboxAutoAllow` + `shouldUseSandbox`).
 *
 * omp contract (`security/core/types.ts` `PermissionCheckContext.canSandboxAutoAllow`):
 * `(toolName: string, input: Record<string, unknown>) => boolean` — true when
 * this exact call would run inside an OS sandbox the user configured to
 * auto-allow. The decision engine consults it before enforcing ask rules;
 * deny rules stay unconditional.
 *
 * CC parity notes:
 * - CC gates the auto-allow on `isSandboxingEnabled() &&
 *   isAutoAllowBashIfSandboxedEnabled() && shouldUseSandbox(input)`; the
 *   predicate below folds those three checks together.
 * - `sandbox.autoAllowBashIfSandboxed` defaults to true in CC and in omp's
 *   settings registry; `sandbox.enabled` defaults to false.
 * - Excluded commands are convenience, not a security boundary — an excluded
 *   command will NOT be sandboxed, so it must NOT be auto-allowed.
 *
 * Pure module: options in, predicate + runtime config out. Availability comes
 * from an injectable probe so tests can force unsupported setups.
 *
 * This module must stay free of imports outside Node builtins and its own
 * sandbox siblings (`./runtimeConfig`, `./excludedCommands`, `./manager`).
 */

import { containsExcludedCommand } from "./excludedCommands";
import { probeSandboxAvailability } from "./manager";
import type { AvailabilityProbe } from "./manager";
import { convertToSandboxRuntimeConfig } from "./runtimeConfig";
import type { SandboxRuntimeConfig } from "./runtimeConfig";

/** The sandbox settings slice the auto-allow decision needs. */
export type SandboxAutoAllowOptions = {
	/** `sandbox.enabled` (cfgSandboxEnabled). Default false. */
	enabled?: boolean;
	/** `sandbox.autoAllowBashIfSandboxed` (cfgSandboxAutoAllowBashIfSandboxed). Default true. */
	autoAllowBashIfSandboxed?: boolean;
	/** `sandbox.excludedCommands` (cfgSandboxExcludedCommands). */
	excludedCommands?: readonly string[];
	/** `sandbox.network.allowedDomains` (cfgSandboxAllowedDomains). */
	allowedDomains?: readonly string[];
	/** `sandbox.allowUnsandboxedCommands`. Default true. */
	allowUnsandboxedCommands?: boolean;
};

export type SandboxAutoAllow = {
	/** Runtime config for the sandbox runtime (network allowlist from options). */
	config: SandboxRuntimeConfig;
	/** `PermissionCheckContext.canSandboxAutoAllow` implementation. */
	canSandboxAutoAllow: (toolName: string, input: Record<string, unknown>) => boolean;
	/** Bash-tool sandbox gate (`shouldUseSandbox` with resolved availability). */
	shouldUseSandbox: (input: { command?: string; dangerouslyDisableSandbox?: boolean }) => boolean;
	/** Platform-probe result captured at creation time. */
	availability: { available: boolean; reason?: string };
};

/**
 * Build the auto-allow predicate and runtime config from pure options plus a
 * platform availability probe. `probe` is injectable for tests; omit it to
 * use the default platform detection.
 */
export function createSandboxAutoAllow(
	options: SandboxAutoAllowOptions,
	deps: { probe?: AvailabilityProbe } = {},
): SandboxAutoAllow {
	const availability = probeSandboxAvailability(deps.probe);

	const config = convertToSandboxRuntimeConfig({
		network: { allowedDomains: [...(options.allowedDomains ?? [])] },
		excludedCommands: options.excludedCommands,
		autoAllowBashIfSandboxed: options.autoAllowBashIfSandboxed,
	});

	const excluded = options.excludedCommands ?? [];
	const allowUnsandboxedCommands = options.allowUnsandboxedCommands ?? true;

	const shouldUseSandbox = (input: { command?: string; dangerouslyDisableSandbox?: boolean }): boolean => {
		if (!options.enabled || !availability.available) return false;
		if (input.dangerouslyDisableSandbox && allowUnsandboxedCommands) return false;
		if (!input.command) return false;
		if (containsExcludedCommand(input.command, excluded)) return false;
		return true;
	};

	const canSandboxAutoAllow = (toolName: string, input: Record<string, unknown>): boolean => {
		// Only shell commands run inside the OS sandbox; omp's bash tool
		// registers as "bash" (Claude Code's "Bash" accepted case-insensitively).
		if (toolName.toLowerCase() !== "bash") return false;
		// Auto-allow only applies when sandboxing is on and will actually wrap
		// this command (CC: isSandboxingEnabled && autoAllowBashIfSandboxed &&
		// shouldUseSandbox).
		if (options.enabled !== true) return false;
		if (!availability.available) return false;
		if ((options.autoAllowBashIfSandboxed ?? true) !== true) return false;
		const command = typeof input.command === "string" ? input.command : undefined;
		if (!command) return false;
		if (input.dangerouslyDisableSandbox === true && allowUnsandboxedCommands) return false;
		return !containsExcludedCommand(command, excluded);
	};

	return {
		config,
		canSandboxAutoAllow,
		shouldUseSandbox,
		availability: { available: availability.available, reason: availability.reason },
	};
}
