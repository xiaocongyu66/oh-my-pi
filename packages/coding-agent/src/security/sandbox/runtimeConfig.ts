/**
 * Sandbox runtime-config types and the settings → runtime-config transform,
 * ported from Claude Code's `src/utils/sandbox/sandbox-adapter.ts`
 * (`convertToSandboxRuntimeConfig`, `resolvePathPatternForSandbox`,
 * `resolveSandboxFilesystemPath`, `shouldAllowManagedSandboxDomainsOnly`).
 *
 * Target shape — the `@anthropic-ai/sandbox-runtime` v0.0.76
 * `SandboxRuntimeConfig` (documented in its README; the zod
 * `SandboxRuntimeConfigSchema` is NOT ported because omp has no zod
 * dependency — `validateSandboxRuntimeConfig` replaces it and throws on
 * malformed config):
 *
 * ```jsonc
 * {
 *   "network": {
 *     "allowedDomains": ["github.com", "*.github.com", "api.example.com:8443"],
 *     "deniedDomains": ["malicious.com"],
 *     "allowUnixSockets": ["/var/run/docker.sock"],
 *     "allowAllUnixSockets": false,
 *     "allowLocalBinding": false,
 *     "httpProxyPort": 0, "socksProxyPort": 0
 *   },
 *   "filesystem": {
 *     "denyRead": ["~/.ssh"], "allowRead": [],
 *     "allowWrite": ["."],    "denyWrite": [".env"]
 *   },
 *   "ignoreViolations": { "git push": ["/usr/bin/nc"] },
 *   "enableWeakerNestedSandbox": false,
 *   "enableWeakerNetworkIsolation": false,
 *   "ripgrep": { "command": "rg", "args": ["..."], "argv0": "rg" }
 * }
 * ```
 *
 * Adaptations from Claude Code:
 * - No settings import: every ambient read (settings sources, Claude temp
 *   dir, cwd state, policy lock) becomes a field on `SandboxConfigOptions`.
 *   The host resolves omp settings ids (`sandbox.*`) into this object; the
 *   gate integration is wired elsewhere.
 * - Single rule source: CC iterates every settings source to resolve `/path`
 *   permission-rule patterns against that source's file directory; omp has
 *   one rule source, so patterns resolve against `settingsRoot` (the host
 *   cwd, mirroring `security/core/pathSafety.ts`).
 * - Dropped (CC-infrastructure specific): settings-file denyWrite entries,
 *   the managed-settings drop-in dir, cwd≠originalCwd dual-path denials,
 *   `.claude/skills` denial, bare-git-repo scrub paths, worktree main-repo
 *   writability, and the CC ripgrep auto-configuration (ripgrep passes
 *   through as an option). `excludedCommands` / `autoAllowBashIfSandboxed`
 *   are accepted as options but are NOT part of the runtime config shape —
 *   the sandbox manager and the auto-allow helper consume them.
 * - No analytics/feature flags.
 *
 * This module must stay free of imports outside Node builtins.
 */

import * as os from "node:os";
import * as path from "node:path";

// ============================================================================
// Runtime config types (@anthropic-ai/sandbox-runtime shape)
// ============================================================================

export type SandboxNetworkRestrictionConfig = {
	/** Domain allowlist; empty array = no network access. Supports `*.example.com` and `:port` suffixes. */
	allowedDomains?: string[];
	/** Checked first; takes precedence over allowedDomains. */
	deniedDomains?: string[];
	/** Optional map from a deniedDomains entry to a model-facing reason. */
	deniedDomainReasons?: Record<string, string>;
	/** Unix socket path allowlist (macOS seatbelt; ignored by seccomp). */
	allowUnixSockets?: string[];
	allowAllUnixSockets?: boolean;
	/** Allow binding to local ports (default false). */
	allowLocalBinding?: boolean;
	httpProxyPort?: number;
	socksProxyPort?: number;
};

export type SandboxFsReadRestrictionConfig = {
	/** Deny-then-allow pattern: empty = full read access. */
	denyRead?: string[];
	/** Re-allows read within denied regions; takes precedence over denyRead. */
	allowRead?: string[];
};

export type SandboxFsWriteRestrictionConfig = {
	/** Empty = no write access. */
	allowWrite?: string[];
	/** Takes precedence over allowWrite. */
	denyWrite?: string[];
};

export type SandboxIgnoreViolationsConfig = Record<string, string[]>;

export type SandboxRipgrepConfig = {
	command: string;
	args?: string[];
	argv0?: string;
};

export type SandboxRuntimeConfig = {
	network: SandboxNetworkRestrictionConfig;
	filesystem: SandboxFsReadRestrictionConfig & SandboxFsWriteRestrictionConfig;
	ignoreViolations?: SandboxIgnoreViolationsConfig;
	enableWeakerNestedSandbox?: boolean;
	enableWeakerNetworkIsolation?: boolean;
	ripgrep?: SandboxRipgrepConfig;
};

/** Host-pattern argument of the sandbox ask callback (CC `NetworkHostPattern`). */
export type SandboxNetworkHostPattern = { host: string; port?: number };

export type SandboxAskCallback = (hostPattern: SandboxNetworkHostPattern) => boolean | Promise<boolean>;

// ============================================================================
// Validation (replaces the zod SandboxRuntimeConfigSchema)
// ============================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, field: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some(v => typeof v !== "string")) {
		throw new Error(`Invalid sandbox runtime config: ${field} must be an array of strings`);
	}
	return value as string[];
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") {
		throw new Error(`Invalid sandbox runtime config: ${field} must be a boolean`);
	}
	return value;
}

function optionalPort(value: unknown, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 65535) {
		throw new Error(`Invalid sandbox runtime config: ${field} must be a port number (0-65535)`);
	}
	return value;
}

/**
 * Validate an untrusted value as a `SandboxRuntimeConfig`. Throws `Error`
 * with a descriptive message on malformed input (zod-schema replacement);
 * unknown fields are passed through untouched.
 */
export function validateSandboxRuntimeConfig(config: unknown): SandboxRuntimeConfig {
	if (!isPlainObject(config)) {
		throw new Error("Invalid sandbox runtime config: expected an object");
	}
	const raw = config as Record<string, unknown>;

	let network: SandboxNetworkRestrictionConfig = {};
	if (raw.network !== undefined) {
		if (!isPlainObject(raw.network)) {
			throw new Error("Invalid sandbox runtime config: network must be an object");
		}
		const n = raw.network as Record<string, unknown>;
		network = {
			allowedDomains: stringArray(n.allowedDomains, "network.allowedDomains"),
			deniedDomains: stringArray(n.deniedDomains, "network.deniedDomains"),
			allowUnixSockets: stringArray(n.allowUnixSockets, "network.allowUnixSockets"),
			allowAllUnixSockets: optionalBoolean(n.allowAllUnixSockets, "network.allowAllUnixSockets"),
			allowLocalBinding: optionalBoolean(n.allowLocalBinding, "network.allowLocalBinding"),
			httpProxyPort: optionalPort(n.httpProxyPort, "network.httpProxyPort"),
			socksProxyPort: optionalPort(n.socksProxyPort, "network.socksProxyPort"),
		};
		const reasons = n.deniedDomainReasons;
		if (reasons !== undefined) {
			if (!isPlainObject(reasons)) {
				throw new Error("Invalid sandbox runtime config: network.deniedDomainReasons must be an object");
			}
			network.deniedDomainReasons = Object.fromEntries(
				Object.entries(reasons).map(([k, v]) => {
					if (typeof v !== "string") {
						throw new Error("Invalid sandbox runtime config: network.deniedDomainReasons values must be strings");
					}
					return [k, v];
				}),
			);
		}
	}

	let filesystem: SandboxRuntimeConfig["filesystem"] = { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] };
	if (raw.filesystem !== undefined) {
		if (!isPlainObject(raw.filesystem)) {
			throw new Error("Invalid sandbox runtime config: filesystem must be an object");
		}
		const f = raw.filesystem as Record<string, unknown>;
		filesystem = {
			denyRead: stringArray(f.denyRead, "filesystem.denyRead"),
			allowRead: stringArray(f.allowRead, "filesystem.allowRead"),
			allowWrite: stringArray(f.allowWrite, "filesystem.allowWrite"),
			denyWrite: stringArray(f.denyWrite, "filesystem.denyWrite"),
		};
	}

	let ignoreViolations: SandboxIgnoreViolationsConfig | undefined;
	if (raw.ignoreViolations !== undefined) {
		if (!isPlainObject(raw.ignoreViolations)) {
			throw new Error("Invalid sandbox runtime config: ignoreViolations must be an object");
		}
		ignoreViolations = Object.fromEntries(
			Object.entries(raw.ignoreViolations).map(([k, v]) => [k, stringArray(v, `ignoreViolations.${k}`)]),
		);
	}

	let ripgrep: SandboxRipgrepConfig | undefined;
	if (raw.ripgrep !== undefined) {
		if (!isPlainObject(raw.ripgrep) || typeof (raw.ripgrep as Record<string, unknown>).command !== "string") {
			throw new Error("Invalid sandbox runtime config: ripgrep must be an object with a string command");
		}
		const r = raw.ripgrep as Record<string, unknown>;
		ripgrep = {
			command: r.command as string,
			args: stringArray(r.args, "ripgrep.args"),
			argv0: r.argv0 === undefined ? undefined : String(r.argv0),
		};
	}

	const enableWeakerNestedSandbox = optionalBoolean(raw.enableWeakerNestedSandbox, "enableWeakerNestedSandbox");
	const enableWeakerNetworkIsolation = optionalBoolean(
		raw.enableWeakerNetworkIsolation,
		"enableWeakerNetworkIsolation",
	);

	return {
		network,
		filesystem,
		...(ignoreViolations !== undefined && { ignoreViolations }),
		...(enableWeakerNestedSandbox !== undefined && { enableWeakerNestedSandbox }),
		...(enableWeakerNetworkIsolation !== undefined && { enableWeakerNetworkIsolation }),
		...(ripgrep !== undefined && { ripgrep }),
	};
}

// ============================================================================
// Permission-rule value parsing (local copy — sandbox-adapter parity)
// ============================================================================

/** CC `PermissionRuleValue`: a bare tool name or `Tool(content)`. */
export type SandboxPermissionRuleValue = { toolName: string; ruleContent?: string };

/** Local copy of CC's `permissionRuleValueFromString` (avoids core imports). */
export function permissionRuleValueFromString(ruleString: string): SandboxPermissionRuleValue {
	const matches = ruleString.match(/^([^(]+)\(([^)]+)\)$/);
	if (!matches) return { toolName: ruleString };
	const toolName = matches[1];
	const ruleContent = matches[2];
	if (!toolName || !ruleContent) return { toolName: ruleString };
	return { toolName, ruleContent };
}

// ============================================================================
// Path pattern resolution
// ============================================================================

/**
 * Resolve Claude Code-specific path patterns from permission rules.
 *
 * - `//path` → absolute from filesystem root (becomes `/path`)
 * - `/path`  → relative to the settings root (becomes `${settingsRoot}/path`)
 * - `~/path`, `./path`, `path` → passed through (the sandbox runtime's
 *   normalizePathForSandbox handles them)
 *
 * CC takes the originating settings source here; omp has a single rule
 * source, so callers pass the settings root directory (host cwd).
 */
export function resolvePathPatternForSandbox(pattern: string, settingsRoot: string): string {
	// Handle // prefix - absolute from root (CC-specific convention)
	if (pattern.startsWith("//")) {
		return pattern.slice(1); // "//.aws/**" → "/.aws/**"
	}
	// Handle / prefix - relative to settings root (CC-specific convention)
	if (pattern.startsWith("/")) {
		return path.resolve(settingsRoot, pattern.slice(1));
	}
	// Other patterns (~/path, ./path, path) pass through as-is
	return pattern;
}

/**
 * Expand `~` / `~/` and resolve relative paths against baseDir (local copy of
 * CC's `expandPath`, which cannot be imported under the sandbox dependency
 * rules). Returns the input unchanged for empty input.
 */
function expandPathLike(inputPath: string, baseDir: string): string {
	const trimmed = inputPath.trim();
	if (trimmed === "~") return os.homedir();
	if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
	if (path.isAbsolute(trimmed)) return path.normalize(trimmed);
	return path.resolve(baseDir, trimmed);
}

/**
 * Resolve paths from `sandbox.filesystem.*` settings. Unlike permission
 * rules these use standard path semantics (CC #30067): `/path` is absolute
 * as written, `~/path` expands to home, `./path`/`path` resolve against the
 * settings root, and `//path` stays a legacy escape to `/path`.
 */
export function resolveSandboxFilesystemPath(pattern: string, settingsRoot: string): string {
	// Legacy permission-rule escape: //path → /path (compat with #30067 workarounds).
	if (pattern.startsWith("//")) return pattern.slice(1);
	return expandPathLike(pattern, settingsRoot);
}

/**
 * True when policy settings lock the sandbox network allowlist to managed
 * domains (CC reads `policySettings.sandbox.network.allowManagedDomainsOnly`).
 * The pure port takes that (possibly untrusted) policy object as an argument.
 */
export function shouldAllowManagedSandboxDomainsOnly(policySettings?: {
	sandbox?: { network?: { allowManagedDomainsOnly?: boolean } };
}): boolean {
	return policySettings?.sandbox?.network?.allowManagedDomainsOnly === true;
}

// ============================================================================
// Settings → runtime config transform
// ============================================================================

/**
 * Plain-object replacement for the CC `SettingsJson` subset the transform
 * consumes. Every ambient CC read became a field here.
 */
export type SandboxConfigOptions = {
	/** `sandbox.network.*` (omp id: sandbox.network.allowedDomains). */
	network?: SandboxNetworkRestrictionConfig;
	/**
	 * `sandbox.filesystem.*` — standard path semantics, resolved via
	 * `resolveSandboxFilesystemPath` against `settingsRoot`.
	 */
	filesystem?: SandboxFsReadRestrictionConfig & SandboxFsWriteRestrictionConfig;
	/** Permission allow rules in Claude Code syntax (`WebFetch(domain:github.com)`, `Edit(/foo/**)`). */
	permissionAllow?: readonly string[];
	/** Permission deny rules (`WebFetch(domain:evil.com)`, `Edit(...)`, `Read(...)`). */
	permissionDeny?: readonly string[];
	/** Root used to resolve `/path` rule patterns and relative filesystem paths (default: cwd). */
	settingsRoot?: string;
	/** Working directory; seeds allowWrite with `.` (default: cwd). */
	cwd?: string;
	/** Extra always-writable base path (CC uses its per-session temp dir). */
	tempDir?: string;
	/** Directories added via --add-dir that sandboxed commands must be able to write. */
	additionalDirectories?: readonly string[];
	/** Extra host-mandated denyWrite entries (CC derives settings files / .claude paths internally). */
	denyWritePaths?: readonly string[];
	/**
	 * Policy lock: only managed domains are allowed. When true the network
	 * allowlist comes exclusively from `managedAllowedDomains` /
	 * `managedPermissionAllow` and permission allow rules are ignored for
	 * domains.
	 */
	allowManagedDomainsOnly?: boolean;
	/** Managed (policy) network domains, consulted only under allowManagedDomainsOnly. */
	managedAllowedDomains?: readonly string[];
	/** Managed (policy) allow rules, consulted only under allowManagedDomainsOnly. */
	managedPermissionAllow?: readonly string[];
	/**
	 * Managed-read lock (CC `allowManagedReadPathsOnly`): when true, allowRead
	 * comes only from `managedAllowReadPaths`, never from filesystem.allowRead.
	 */
	allowManagedReadPathsOnly?: boolean;
	/** Managed (policy) allowRead paths, consulted only under allowManagedReadPathsOnly. */
	managedAllowReadPaths?: readonly string[];
	/** `sandbox.ignoreViolations` passthrough. */
	ignoreViolations?: SandboxIgnoreViolationsConfig;
	enableWeakerNestedSandbox?: boolean;
	enableWeakerNetworkIsolation?: boolean;
	/** Ripgrep passthrough (CC auto-configures its vendored rg; the host supplies its own). */
	ripgrep?: SandboxRipgrepConfig;
	/**
	 * Commands excluded from sandboxing and the auto-allow flag are accepted
	 * here so the gate can pass one settings-shaped object, but they are NOT
	 * part of the sandbox-runtime config shape — see `../sandbox/manager.ts`
	 * and `../sandbox/autoAllow.ts`.
	 */
	excludedCommands?: readonly string[];
	autoAllowBashIfSandboxed?: boolean;
};

const WEB_FETCH_TOOL_NAME = "webfetch";
const FILE_EDIT_TOOL_NAME = "edit";
const FILE_READ_TOOL_NAME = "read";

function extractWebFetchDomains(ruleStrings: readonly string[] | undefined): string[] {
	const domains: string[] = [];
	for (const ruleString of ruleStrings ?? []) {
		const rule = permissionRuleValueFromString(ruleString);
		if (rule.toolName.toLowerCase() !== WEB_FETCH_TOOL_NAME) continue;
		if (!rule.ruleContent?.startsWith("domain:")) continue;
		domains.push(rule.ruleContent.substring("domain:".length));
	}
	return domains;
}

/**
 * Convert sandbox settings options into a `SandboxRuntimeConfig`
 * (function exported for testing). Ported from CC's
 * `convertToSandboxRuntimeConfig`.
 */
export function convertToSandboxRuntimeConfig(options: SandboxConfigOptions): SandboxRuntimeConfig {
	const settingsRoot = options.settingsRoot ?? process.cwd();

	// Extract network domains from WebFetch rules. Under the managed-only
	// policy lock, domains come exclusively from the managed policy inputs.
	const allowedDomains: string[] = [];
	const deniedDomains: string[] = [];
	if (options.allowManagedDomainsOnly === true) {
		allowedDomains.push(...(options.managedAllowedDomains ?? []));
		allowedDomains.push(...extractWebFetchDomains(options.managedPermissionAllow));
	} else {
		allowedDomains.push(...(options.network?.allowedDomains ?? []));
		allowedDomains.push(...extractWebFetchDomains(options.permissionAllow));
	}
	deniedDomains.push(...extractWebFetchDomains(options.permissionDeny));

	// Extract filesystem paths from Edit and Read rules.
	// Always include the current directory (and CC's temp dir, when provided)
	// as writable.
	const allowWrite: string[] = [options.cwd ?? ".", ...(options.tempDir ? [options.tempDir] : [])];
	const denyWrite: string[] = [...(options.denyWritePaths ?? [])];
	const denyRead: string[] = [];
	const allowRead: string[] = [];

	// Additional directories must be writable inside the sandbox so Bash
	// commands (not just file tools) can access them.
	allowWrite.push(...new Set(options.additionalDirectories ?? []));

	// Permission rules: `/foo` is settings-root-relative (permission-rule
	// convention), resolved via resolvePathPatternForSandbox.
	for (const ruleString of options.permissionAllow ?? []) {
		const rule = permissionRuleValueFromString(ruleString);
		if (rule.toolName.toLowerCase() === FILE_EDIT_TOOL_NAME && rule.ruleContent) {
			allowWrite.push(resolvePathPatternForSandbox(rule.ruleContent, settingsRoot));
		}
	}
	for (const ruleString of options.permissionDeny ?? []) {
		const rule = permissionRuleValueFromString(ruleString);
		if (!rule.ruleContent) continue;
		if (rule.toolName.toLowerCase() === FILE_EDIT_TOOL_NAME) {
			denyWrite.push(resolvePathPatternForSandbox(rule.ruleContent, settingsRoot));
		}
		if (rule.toolName.toLowerCase() === FILE_READ_TOOL_NAME) {
			denyRead.push(resolvePathPatternForSandbox(rule.ruleContent, settingsRoot));
		}
	}

	// sandbox.filesystem.* uses standard path semantics (/path = absolute),
	// NOT the permission-rule convention (#30067).
	const fs = options.filesystem;
	if (fs) {
		for (const p of fs.allowWrite ?? []) allowWrite.push(resolveSandboxFilesystemPath(p, settingsRoot));
		for (const p of fs.denyWrite ?? []) denyWrite.push(resolveSandboxFilesystemPath(p, settingsRoot));
		for (const p of fs.denyRead ?? []) denyRead.push(resolveSandboxFilesystemPath(p, settingsRoot));
		if (options.allowManagedReadPathsOnly !== true) {
			for (const p of fs.allowRead ?? []) allowRead.push(resolveSandboxFilesystemPath(p, settingsRoot));
		} else {
			for (const p of options.managedAllowReadPaths ?? [])
				allowRead.push(resolveSandboxFilesystemPath(p, settingsRoot));
		}
	}

	const config: SandboxRuntimeConfig = {
		network: {
			allowedDomains,
			deniedDomains,
			...(options.network?.allowUnixSockets !== undefined && {
				allowUnixSockets: [...options.network.allowUnixSockets],
			}),
			...(options.network?.allowAllUnixSockets !== undefined && {
				allowAllUnixSockets: options.network.allowAllUnixSockets,
			}),
			...(options.network?.allowLocalBinding !== undefined && {
				allowLocalBinding: options.network.allowLocalBinding,
			}),
			...(options.network?.httpProxyPort !== undefined && { httpProxyPort: options.network.httpProxyPort }),
			...(options.network?.socksProxyPort !== undefined && { socksProxyPort: options.network.socksProxyPort }),
		},
		filesystem: {
			denyRead: [...new Set(denyRead)],
			allowRead: [...new Set(allowRead)],
			allowWrite: [...new Set(allowWrite)],
			denyWrite: [...new Set(denyWrite)],
		},
		...(options.ignoreViolations !== undefined && { ignoreViolations: options.ignoreViolations }),
		...(options.enableWeakerNestedSandbox !== undefined && {
			enableWeakerNestedSandbox: options.enableWeakerNestedSandbox,
		}),
		...(options.enableWeakerNetworkIsolation !== undefined && {
			enableWeakerNetworkIsolation: options.enableWeakerNetworkIsolation,
		}),
		...(options.ripgrep !== undefined && { ripgrep: options.ripgrep }),
	};
	return config;
}
