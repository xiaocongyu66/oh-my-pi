/**
 * OS-sandbox manager, ported from Claude Code's
 * `src/utils/sandbox/sandbox-adapter.ts` (`SandboxManager`, `ISandboxManager`,
 * `addToExcludedCommands`, `wrapWithSandbox`).
 *
 * Adaptations from Claude Code (hard dependency constraints):
 * - NO static import of `@anthropic-ai/sandbox-runtime` (not installed in
 *   omp, and the package may not be added): the runtime module is loaded via
 *   `await import(...)` inside try/catch. When it cannot be loaded, the
 *   manager degrades gracefully — `isAvailable()` reports false and every
 *   consumer must treat commands as NOT sandboxed (rules/prompts proceed as
 *   usual); `wrapWithSandbox` returns the command unchanged. Nothing ever
 *   throws out of availability probing or initialization.
 * - Availability is probed without the package: macOS checks for
 *   `/usr/bin/sandbox-exec`; Linux probes `bwrap` (bubblewrap) via a
 *   `node:child_process` `spawnSync --help`; every other platform is
 *   unsupported. CC's BaseSandboxManager.isSupportedPlatform /
 *   checkDependencies are replaced by this probe while the package is absent.
 * - No settings imports (CC reads getSettings_DEPRECATED ambiently): the
 *   sandbox settings ids (`sandbox.enabled`, `sandbox.autoAllowBashIfSandboxed`,
 *   `sandbox.excludedCommands`, `sandbox.network.allowedDomains`,
 *   `sandbox.allowUnsandboxedCommands`) are supplied as plain options via
 *   `createSandboxManager` / `SandboxManager.configure`; the gate integration
 *   is wired by the host.
 * - CC's spawn-time wrapper lives inside the sandbox-runtime package
 *   (`BaseSandboxManager.wrapWithSandbox`); it is not reimplemented here —
 *   the manager only forwards to it when the module loaded and initialized.
 * - Dropped: settings-change subscription, worktree main-repo detection,
 *   bare-git-repo scrubbing, Linux glob warnings, CC's ripgrep
 *   auto-configuration, and the proxy/socket accessors that only forward to
 *   the (absent) runtime package.
 *
 * This module must stay free of imports outside Node builtins and its own
 * sandbox siblings (`./runtimeConfig`).
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { convertToSandboxRuntimeConfig, validateSandboxRuntimeConfig } from "./runtimeConfig";
import type { SandboxAskCallback, SandboxRuntimeConfig } from "./runtimeConfig";

// ============================================================================
// Availability probing
// ============================================================================

export type SandboxAvailability = {
	/** True only when a sandbox primitive exists AND the runtime module loaded. */
	available: boolean;
	platform: NodeJS.Platform;
	/** Human-readable explanation when available is false. */
	reason?: string;
};

/** Injectable platform probe returning true when a sandbox primitive exists. */
export type AvailabilityProbe = () => boolean;

const MACOS_SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const BWRAP_PROBE_TIMEOUT_MS = 5000;

/**
 * Default platform probe. macOS: `/usr/bin/sandbox-exec` exists check. Linux:
 * `bwrap --help` via spawnSync (any completed spawn without an error means
 * bubblewrap is present). Everything else: unavailable. Never throws.
 */
export function defaultAvailabilityProbe(platform: NodeJS.Platform = process.platform): boolean {
	try {
		if (platform === "darwin") {
			return existsSync(MACOS_SANDBOX_EXEC);
		}
		if (platform === "linux") {
			const result = spawnSync("bwrap", ["--help"], { timeout: BWRAP_PROBE_TIMEOUT_MS, stdio: "ignore" });
			return !result.error;
		}
		return false;
	} catch {
		return false;
	}
}

/**
 * Probe sandbox availability with an (optionally injected) platform probe.
 * Availability here means "a sandbox primitive exists"; the runtime-module
 * check happens at initialize(). Never throws — a throwing probe is reported
 * as unavailable with its error as the reason.
 */
export function probeSandboxAvailability(probe: AvailabilityProbe = defaultAvailabilityProbe): SandboxAvailability {
	const platform = process.platform;
	try {
		if (probe()) return { available: true, platform };
		return {
			available: false,
			platform,
			reason:
				platform === "darwin"
					? `${MACOS_SANDBOX_EXEC} not found`
					: platform === "linux"
						? "bwrap (bubblewrap) not found on PATH"
						: `platform ${platform} has no sandbox primitive`,
		};
	} catch (error) {
		return { available: false, platform, reason: `availability probe failed: ${String(error)}` };
	}
}

// Memoized default-probe result (CC memoized isSupportedPlatform/checkDependencies).
let cachedAvailability: SandboxAvailability | undefined;

/** Memoized availability with the default probe; resets on reset(). */
export function getCachedSandboxAvailability(): SandboxAvailability {
	if (!cachedAvailability) cachedAvailability = probeSandboxAvailability();
	return cachedAvailability;
}

export function resetSandboxAvailabilityCache(): void {
	cachedAvailability = undefined;
}

// ============================================================================
// Optional sandbox-runtime module loading (dynamic, never static)
// ============================================================================

const SANDBOX_RUNTIME_MODULE_ID = "@anthropic-ai/sandbox-runtime";

export type SandboxRuntimeDependencyCheck = { errors: string[]; warnings: string[] };

/**
 * Minimal structural type of the parts of `@anthropic-ai/sandbox-runtime`
 * the manager forwards to. Kept local so the module stays importable without
 * the package installed.
 */
type SandboxRuntimeManager = {
	initialize(config: SandboxRuntimeConfig, onAsk?: SandboxAskCallback): Promise<void>;
	updateConfig(config: SandboxRuntimeConfig): void;
	isSupportedPlatform(): boolean;
	checkDependencies(deps: { command: string; args?: string[] }): SandboxRuntimeDependencyCheck;
	wrapWithSandbox(
		command: string,
		binShell?: string,
		customConfig?: Partial<SandboxRuntimeConfig>,
		abortSignal?: AbortSignal,
	): Promise<string>;
	cleanupAfterCommand(): void;
	reset(): Promise<void>;
};

export type SandboxRuntimeModule = { SandboxManager: SandboxRuntimeManager };

/**
 * Load `@anthropic-ai/sandbox-runtime` dynamically. Returns undefined when
 * the package is absent or broken — the specifier is held in a variable so
 * the import is never statically resolved. Never throws.
 */
export async function loadSandboxRuntimeModule(): Promise<SandboxRuntimeModule | undefined> {
	try {
		const moduleId = SANDBOX_RUNTIME_MODULE_ID;
		const mod = (await import(moduleId)) as unknown as Partial<SandboxRuntimeModule>;
		if (!mod || typeof mod.SandboxManager?.wrapWithSandbox !== "function") return undefined;
		return mod as SandboxRuntimeModule;
	} catch {
		return undefined;
	}
}

// ============================================================================
// Manager
// ============================================================================

export type SandboxManagerOptions = {
	/** `sandbox.enabled` (omp id cfgSandboxEnabled). Default false. */
	enabled?: boolean;
	/** `sandbox.autoAllowBashIfSandboxed` (cfgSandboxAutoAllowBashIfSandboxed). CC default: true. */
	autoAllowBashIfSandboxed?: boolean;
	/** `sandbox.excludedCommands` (cfgSandboxExcludedCommands). Convenience, not a security boundary. */
	excludedCommands?: readonly string[];
	/** `sandbox.network.allowedDomains` (cfgSandboxAllowedDomains). */
	allowedDomains?: readonly string[];
	/** `sandbox.allowUnsandboxedCommands`. CC default: true. */
	allowUnsandboxedCommands?: boolean;
	/** `sandbox.failIfUnavailable` — when true with enabled, isSandboxRequired(). CC default: false. */
	failIfUnavailable?: boolean;
	/** Full runtime-config override; built from the options when omitted. */
	config?: SandboxRuntimeConfig;
	/** Ask callback the runtime invokes for unlisted network hosts. */
	onAsk?: SandboxAskCallback;
};

/** Permission-update suggestion shape used by addToExcludedCommands (CC parity). */
export type SandboxPermissionUpdate = {
	type: string;
	rules: Array<{ toolName: string; ruleContent?: string }>;
};

export interface ISandboxManager {
	configure(options: SandboxManagerOptions): void;
	getOptions(): Readonly<SandboxManagerOptions>;
	isAvailable(): boolean;
	isSupportedPlatform(): boolean;
	getAvailability(): SandboxAvailability;
	/** Reason when the user explicitly enabled sandbox but it cannot run; else undefined. */
	getSandboxUnavailableReason(): string | undefined;
	isSandboxingEnabled(): boolean;
	isSandboxEnabledInSettings(): boolean;
	isAutoAllowBashIfSandboxedEnabled(): boolean;
	areUnsandboxedCommandsAllowed(): boolean;
	isSandboxRequired(): boolean;
	getExcludedCommands(): string[];
	/** Add a command (or the prefix of a suggested Bash rule) to the excluded list; returns the pattern added. */
	addToExcludedCommands(command: string, permissionUpdates?: SandboxPermissionUpdate[]): string;
	checkDependencies(): SandboxRuntimeDependencyCheck;
	/** Load the runtime module and hand it the runtime config. Resolves false on any failure. */
	initialize(): Promise<boolean>;
	/** Push an updated runtime config to the loaded runtime (no-op when unavailable). */
	refreshConfig(config?: SandboxRuntimeConfig): void;
	buildRuntimeConfig(): SandboxRuntimeConfig;
	/**
	 * Wrap a command for sandboxed execution via the runtime package. When the
	 * runtime is unavailable the command is returned unchanged — callers must
	 * treat it as NOT sandboxed.
	 */
	wrapWithSandbox(
		command: string,
		binShell?: string,
		customConfig?: Partial<SandboxRuntimeConfig>,
		abortSignal?: AbortSignal,
	): Promise<string>;
	cleanupAfterCommand(): void;
	reset(): Promise<void>;
}

/**
 * Extract the excluded-command pattern from permission suggestions: if the
 * suggestions contain Bash rules, use the prefix of `Bash(cmd:*)` (or the
 * literal `Bash(cmd)` content); otherwise the exact command. Ported from CC's
 * addToExcludedCommands pattern selection.
 */
export function resolveExcludedCommandPattern(command: string, permissionUpdates?: SandboxPermissionUpdate[]): string {
	if (permissionUpdates) {
		const bashSuggestions = permissionUpdates.filter(
			update => update.type === "addRules" && update.rules.some(rule => rule.toolName.toLowerCase() === "bash"),
		);
		const firstBashSuggestion = bashSuggestions[0];
		if (firstBashSuggestion && firstBashSuggestion.type === "addRules") {
			const firstBashRule = firstBashSuggestion.rules.find(rule => rule.toolName.toLowerCase() === "bash");
			if (firstBashRule?.ruleContent) {
				// Extract pattern from Bash(command) or Bash(command:*) format
				const prefixMatch = firstBashRule.ruleContent.match(/^(.+):\*$/);
				return prefixMatch?.[1] ?? firstBashRule.ruleContent;
			}
		}
	}
	return command;
}

class SandboxManagerImpl implements ISandboxManager {
	protected options: SandboxManagerOptions;
	protected excludedCommands: string[];
	protected deps: { probe?: AvailabilityProbe };
	protected runtimeModule: SandboxRuntimeModule | undefined;
	protected initializationPromise: Promise<boolean> | undefined;

	constructor(options: SandboxManagerOptions = {}, deps: { probe?: AvailabilityProbe } = {}) {
		this.options = { ...options };
		this.excludedCommands = [...(options.excludedCommands ?? [])];
		this.deps = deps;
	}

	configure(options: SandboxManagerOptions): void {
		this.options = { ...this.options, ...options };
		if (options.excludedCommands !== undefined) {
			this.excludedCommands = [...options.excludedCommands];
		}
	}

	getOptions(): Readonly<SandboxManagerOptions> {
		return { ...this.options, excludedCommands: [...this.excludedCommands] };
	}

	getAvailability(): SandboxAvailability {
		// An injected probe is evaluated fresh (test seam); the default probe is
		// memoized for process lifetime.
		if (this.deps.probe) return probeSandboxAvailability(this.deps.probe);
		return getCachedSandboxAvailability();
	}

	isAvailable(): boolean {
		return this.getAvailability().available && this.runtimeModule !== undefined && this.initialized;
	}

	isSupportedPlatform(): boolean {
		return this.getAvailability().available;
	}

	getSandboxUnavailableReason(): string | undefined {
		// Only warn if the user explicitly asked for sandbox.
		if (this.options.enabled !== true) return undefined;
		const availability = this.getAvailability();
		if (availability.available) return undefined;
		return `sandbox.enabled is set but the OS sandbox is unavailable: ${availability.reason ?? "unknown reason"}`;
	}

	isSandboxingEnabled(): boolean {
		if (this.options.enabled !== true) return false;
		return this.getAvailability().available;
	}

	isSandboxEnabledInSettings(): boolean {
		return this.options.enabled === true;
	}

	isAutoAllowBashIfSandboxedEnabled(): boolean {
		return this.options.autoAllowBashIfSandboxed ?? true;
	}

	areUnsandboxedCommandsAllowed(): boolean {
		return this.options.allowUnsandboxedCommands ?? true;
	}

	isSandboxRequired(): boolean {
		return this.options.enabled === true && (this.options.failIfUnavailable ?? false);
	}

	getExcludedCommands(): string[] {
		return [...this.excludedCommands];
	}

	addToExcludedCommands(command: string, permissionUpdates?: SandboxPermissionUpdate[]): string {
		const commandPattern = resolveExcludedCommandPattern(command, permissionUpdates);
		if (!this.excludedCommands.includes(commandPattern)) {
			this.excludedCommands.push(commandPattern);
		}
		return commandPattern;
	}

	checkDependencies(): SandboxRuntimeDependencyCheck {
		const runtime = this.runtimeModule;
		if (runtime) {
			try {
				return runtime.SandboxManager.checkDependencies({});
			} catch (error) {
				return { errors: [`sandbox dependency check failed: ${String(error)}`], warnings: [] };
			}
		}
		const availability = this.getAvailability();
		if (!availability.available) {
			return { errors: [availability.reason ?? "sandbox unavailable"], warnings: [] };
		}
		return { errors: ["@anthropic-ai/sandbox-runtime is not loaded"], warnings: [] };
	}

	buildRuntimeConfig(): SandboxRuntimeConfig {
		if (this.options.config) return validateSandboxRuntimeConfig(this.options.config);
		return convertToSandboxRuntimeConfig({
			network: { allowedDomains: [...(this.options.allowedDomains ?? [])] },
		});
	}

	private get initialized(): boolean {
		return this.initializationPromise !== undefined && this.runtimeModule !== undefined;
	}

	initialize(): Promise<boolean> {
		if (!this.isSandboxingEnabled()) return Promise.resolve(false);
		if (this.initializationPromise) return this.initializationPromise;

		// Create the promise synchronously (before any await) so concurrent
		// wrapWithSandbox calls cannot slip past an in-flight initialization.
		this.initializationPromise = (async () => {
			try {
				const runtime = await loadSandboxRuntimeModule();
				if (!runtime) {
					this.runtimeModule = undefined;
					this.initializationPromise = undefined;
					return false;
				}
				await runtime.SandboxManager.initialize(this.buildRuntimeConfig(), this.options.onAsk);
				this.runtimeModule = runtime;
				return true;
			} catch {
				// Log-and-degrade: sandboxing is an enhancement, never a hard failure.
				this.runtimeModule = undefined;
				this.initializationPromise = undefined;
				return false;
			}
		})();
		return this.initializationPromise;
	}

	refreshConfig(config?: SandboxRuntimeConfig): void {
		const runtime = this.runtimeModule;
		if (!runtime) return;
		try {
			runtime.SandboxManager.updateConfig(config ?? this.buildRuntimeConfig());
		} catch {
			// Configuration refresh is best-effort; the stale config stays active.
		}
	}

	async wrapWithSandbox(
		command: string,
		binShell?: string,
		customConfig?: Partial<SandboxRuntimeConfig>,
		abortSignal?: AbortSignal,
	): Promise<string> {
		const runtime = this.runtimeModule;
		if (!runtime || !this.initialized) return command;
		try {
			return await runtime.SandboxManager.wrapWithSandbox(command, binShell, customConfig, abortSignal);
		} catch {
			// Degrade to unsandboxed execution rather than failing the tool call;
			// the permission flow already treats un-wrapped commands as not sandboxed.
			return command;
		}
	}

	cleanupAfterCommand(): void {
		try {
			this.runtimeModule?.SandboxManager.cleanupAfterCommand();
		} catch {
			// Best-effort cleanup.
		}
	}

	async reset(): Promise<void> {
		const runtime = this.runtimeModule;
		this.runtimeModule = undefined;
		this.initializationPromise = undefined;
		resetSandboxAvailabilityCache();
		if (runtime) {
			try {
				await runtime.SandboxManager.reset();
			} catch {
				// Reset is best-effort.
			}
		}
	}
}

/**
 * Create a manager instance with explicit options and an optional injected
 * availability probe (test seam).
 */
export function createSandboxManager(
	options: SandboxManagerOptions = {},
	deps: { probe?: AvailabilityProbe } = {},
): ISandboxManager {
	return new SandboxManagerImpl(options, deps);
}

/**
 * Process-wide manager (CC exports a singleton). Starts disabled; the host
 * calls `SandboxManager.configure(...)` with the resolved omp sandbox
 * settings before use.
 */
export const SandboxManager: ISandboxManager = new SandboxManagerImpl();
