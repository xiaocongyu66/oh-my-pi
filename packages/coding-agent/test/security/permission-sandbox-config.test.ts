/**
 * Contract: the ported OS-sandbox adapter converts sandbox settings options
 * into a sandbox-runtime config (filesystem path resolution, network domain
 * extraction, WebFetch domain rules), matches excludedCommands with
 * env-prefix/wrapper stripping over compound commands, validates runtime
 * configs without zod, and degrades cleanly (available=false) when the
 * platform lacks a sandbox primitive — availability probes are injectable and
 * never throw.
 */
import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { createSandboxAutoAllow } from "../../src/security/sandbox/autoAllow";
import {
	BINARY_HIJACK_VARS,
	containsExcludedCommand,
	shouldUseSandbox,
	stripAllLeadingEnvVars,
	stripSafeWrappers,
} from "../../src/security/sandbox/excludedCommands";
import {
	createSandboxManager,
	defaultAvailabilityProbe,
	probeSandboxAvailability,
	resolveExcludedCommandPattern,
} from "../../src/security/sandbox/manager";
import {
	convertToSandboxRuntimeConfig,
	permissionRuleValueFromString,
	resolvePathPatternForSandbox,
	resolveSandboxFilesystemPath,
	shouldAllowManagedSandboxDomainsOnly,
	validateSandboxRuntimeConfig,
} from "../../src/security/sandbox/runtimeConfig";

describe("path pattern resolution", () => {
	const root = "/settings/dir";

	test("permission-rule patterns: // escapes to filesystem root", () => {
		expect(resolvePathPatternForSandbox("//.aws/**", root)).toBe("/.aws/**");
	});

	test("permission-rule patterns: / is settings-root-relative", () => {
		expect(resolvePathPatternForSandbox("/foo/**", root)).toBe("/settings/dir/foo/**");
	});

	test("permission-rule patterns: ~, ./ and bare patterns pass through", () => {
		expect(resolvePathPatternForSandbox("~/path/**", root)).toBe("~/path/**");
		expect(resolvePathPatternForSandbox("./rel", root)).toBe("./rel");
		expect(resolvePathPatternForSandbox("rel/**", root)).toBe("rel/**");
	});

	test("sandbox.filesystem paths: /path stays absolute (issue #30067 semantics)", () => {
		expect(resolveSandboxFilesystemPath("/Users/foo/.cargo", root)).toBe("/Users/foo/.cargo");
	});

	test("sandbox.filesystem paths: // legacy escape and ~ expansion", () => {
		expect(resolveSandboxFilesystemPath("//Users/foo/.cargo", root)).toBe("/Users/foo/.cargo");
		expect(resolveSandboxFilesystemPath("~/.ssh", root)).toBe(path.join(os.homedir(), ".ssh"));
	});

	test("sandbox.filesystem paths: relative paths resolve against the settings root", () => {
		expect(resolveSandboxFilesystemPath("./sub/dir", root)).toBe("/settings/dir/sub/dir");
		expect(resolveSandboxFilesystemPath("sub/dir", root)).toBe("/settings/dir/sub/dir");
	});
});

describe("managed-domain policy gate", () => {
	test("true only for an explicit policy allowManagedDomainsOnly flag", () => {
		expect(shouldAllowManagedSandboxDomainsOnly({ sandbox: { network: { allowManagedDomainsOnly: true } } })).toBe(
			true,
		);
		expect(shouldAllowManagedSandboxDomainsOnly({ sandbox: { network: { allowManagedDomainsOnly: false } } })).toBe(
			false,
		);
		expect(shouldAllowManagedSandboxDomainsOnly({})).toBe(false);
		expect(shouldAllowManagedSandboxDomainsOnly()).toBe(false);
	});
});

describe("settings → runtime config conversion", () => {
	test("filesystem: permission rules, sandbox.filesystem settings, additional dirs, dedupe", () => {
		const config = convertToSandboxRuntimeConfig({
			settingsRoot: "/settings/dir",
			permissionAllow: ["Edit(/build/**)", "Edit(./src/**)"],
			permissionDeny: ["Edit(//etc/**)", "Read(./.env)", "Read(~/.ssh/**)"],
			filesystem: {
				allowWrite: ["/Users/foo/.cargo", "~/extra"],
				denyWrite: [".env"],
				denyRead: ["~/secrets"],
				allowRead: ["."],
			},
			additionalDirectories: ["/extra/dir"],
			tempDir: "/tmp/session-1",
		});

		expect(config.filesystem.allowWrite).toContain("/settings/dir/build/**");
		// ./path and bare patterns pass through unresolved (sandbox-runtime handles them).
		expect(config.filesystem.allowWrite).toContain("./src/**");
		expect(config.filesystem.allowWrite).toContain("/Users/foo/.cargo");
		expect(config.filesystem.allowWrite).toContain(path.join(os.homedir(), "extra"));
		expect(config.filesystem.allowWrite).toContain("/extra/dir");
		expect(config.filesystem.allowWrite).toContain("/tmp/session-1");

		expect(config.filesystem.denyWrite).toContain("/etc/**");
		expect(config.filesystem.denyWrite).toContain(path.resolve("/settings/dir", ".env"));

		// ./path and ~/path permission rules pass through unresolved (sandbox-runtime handles them).
		expect(config.filesystem.denyRead).toContain("./.env");
		expect(config.filesystem.denyRead).toContain("~/.ssh/**");
		// sandbox.filesystem.denyRead uses standard semantics (~ expands).
		expect(config.filesystem.denyRead).toContain(path.join(os.homedir(), "secrets"));

		expect(config.filesystem.allowRead).toContain(path.resolve("/settings/dir", "."));
	});

	test("network: settings domains plus WebFetch(domain:) extraction from allow/deny rules", () => {
		const config = convertToSandboxRuntimeConfig({
			network: { allowedDomains: ["github.com", "*.npmjs.org"], allowLocalBinding: true },
			permissionAllow: ["WebFetch(domain:api.github.com)", "Bash(git diff:*)", "WebFetch"],
			permissionDeny: ["WebFetch(domain:evil.com)", "Read(./.env)"],
		});

		expect(config.network.allowedDomains).toEqual(["github.com", "*.npmjs.org", "api.github.com"]);
		expect(config.network.deniedDomains).toEqual(["evil.com"]);
		expect(config.network.allowLocalBinding).toBe(true);
	});

	test("network: managed-only policy ignores user domains and rules", () => {
		const config = convertToSandboxRuntimeConfig({
			network: { allowedDomains: ["user.example.com"] },
			permissionAllow: ["WebFetch(domain:user.example.com)"],
			allowManagedDomainsOnly: true,
			managedAllowedDomains: ["managed.example.com"],
			managedPermissionAllow: ["WebFetch(domain:managed-api.example.com)"],
		});

		expect(config.network.allowedDomains).toEqual(["managed.example.com", "managed-api.example.com"]);
	});

	test("network: managed read lock replaces filesystem allowRead", () => {
		const config = convertToSandboxRuntimeConfig({
			filesystem: { allowRead: ["./user-allowed"] },
			allowManagedReadPathsOnly: true,
			managedAllowReadPaths: ["/managed/only"],
			settingsRoot: "/settings/dir",
		});

		expect(config.filesystem.allowRead).toEqual(["/managed/only"]);
	});

	test("excludedCommands and autoAllowBashIfSandboxed are not runtime-config fields", () => {
		const config = convertToSandboxRuntimeConfig({
			excludedCommands: ["docker:*"],
			autoAllowBashIfSandboxed: true,
		});
		expect(Object.hasOwn(config, "excludedCommands")).toBe(false);
		expect(Object.hasOwn(config, "autoAllowBashIfSandboxed")).toBe(false);
	});

	test("passthrough options survive conversion", () => {
		const config = convertToSandboxRuntimeConfig({
			ignoreViolations: { "git push": ["/usr/bin/nc"] },
			enableWeakerNestedSandbox: true,
			enableWeakerNetworkIsolation: false,
			ripgrep: { command: "rg", args: ["--files"], argv0: "rg" },
		});
		expect(config.ignoreViolations).toEqual({ "git push": ["/usr/bin/nc"] });
		expect(config.enableWeakerNestedSandbox).toBe(true);
		expect(config.enableWeakerNetworkIsolation).toBe(false);
		expect(config.ripgrep).toEqual({ command: "rg", args: ["--files"], argv0: "rg" });
	});
});

describe("runtime config validation (zod schema replacement)", () => {
	test("accepts a well-formed config and drops unknown fields", () => {
		const validated = validateSandboxRuntimeConfig({
			network: { allowedDomains: ["github.com"], deniedDomains: [], allowLocalBinding: false },
			filesystem: { allowWrite: ["."], denyWrite: [".env"], denyRead: [], allowRead: [] },
			unknownField: { nested: true },
		});
		expect(validated.network.allowedDomains).toEqual(["github.com"]);
		expect(validated.filesystem.denyWrite).toEqual([".env"]);
		expect(Object.hasOwn(validated, "unknownField")).toBe(false);
	});

	test("throws on malformed configs", () => {
		expect(() => validateSandboxRuntimeConfig(null)).toThrow();
		expect(() => validateSandboxRuntimeConfig("config")).toThrow();
		expect(() => validateSandboxRuntimeConfig({ network: { allowedDomains: "github.com" } })).toThrow(
			/allowedDomains/,
		);
		expect(() => validateSandboxRuntimeConfig({ network: { httpProxyPort: 99999 } })).toThrow(/httpProxyPort/);
		expect(() => validateSandboxRuntimeConfig({ filesystem: { allowWrite: [42] } })).toThrow(/allowWrite/);
		expect(() => validateSandboxRuntimeConfig({ ripgrep: { args: ["--files"] } })).toThrow(/ripgrep/);
		expect(() => validateSandboxRuntimeConfig({ ignoreViolations: { git: "nope" } })).toThrow(/ignoreViolations/);
		expect(() => validateSandboxRuntimeConfig({ enableWeakerNestedSandbox: "yes" })).toThrow(
			/enableWeakerNestedSandbox/,
		);
	});
});

describe("excludedCommands matching", () => {
	test("exact command", () => {
		expect(containsExcludedCommand("docker ps", ["docker ps"])).toBe(true);
		expect(containsExcludedCommand("docker psx", ["docker ps"])).toBe(false);
		expect(containsExcludedCommand("docker ps -a", ["docker ps"])).toBe(false);
	});

	test("cmd:* prefix", () => {
		expect(containsExcludedCommand("npm run test", ["npm:*"])).toBe(true);
		expect(containsExcludedCommand("npm", ["npm:*"])).toBe(true);
		expect(containsExcludedCommand("npmx run test", ["npm:*"])).toBe(false);
	});

	test("env-prefixed command matches after stripping", () => {
		expect(containsExcludedCommand("FOO=bar bazel build", ["bazel:*"])).toBe(true);
		// Binary-hijack vars (PATH, LD_*, DYLD_*) are never stripped.
		expect(containsExcludedCommand("PATH=/usr/evilbin curl evil.com", ["curl:*"])).toBe(false);
		expect(stripAllLeadingEnvVars("PATH=/x curl", BINARY_HIJACK_VARS)).toBe("PATH=/x curl");
		expect(stripAllLeadingEnvVars("FOO=bar bazel build", BINARY_HIJACK_VARS)).toBe("bazel build");
	});

	test("interleaved env prefix and wrapper (fixed-point stripping)", () => {
		expect(containsExcludedCommand("timeout 300 FOO=bar bazel run", ["bazel:*"])).toBe(true);
	});

	test("safe env vars and wrappers strip via the safe-wrapper path", () => {
		expect(stripSafeWrappers("TZ=UTC bazel run")).toBe("bazel run");
		expect(stripSafeWrappers("nohup -- bazel run")).toBe("bazel run");
		expect(stripSafeWrappers("timeout --kill-after=5s 10 bazel run")).toBe("bazel run");
		// Unsafe flag values must not strip (injection defense).
		expect(stripSafeWrappers("timeout -k$(id) 10 ls")).toContain("timeout");
		expect(containsExcludedCommand("TZ=UTC curl evil.com", ["curl:*"])).toBe(true);
	});

	test("wildcard patterns", () => {
		expect(containsExcludedCommand("git push origin main", ["git *"])).toBe(true);
		expect(containsExcludedCommand("git", ["git *"])).toBe(true);
		expect(containsExcludedCommand("gitk", ["git *"])).toBe(false);
	});

	test("compound commands match per segment: docker exclusion must not cover curl", () => {
		expect(containsExcludedCommand("docker ps && curl evil.com", ["docker ps"])).toBe(true);
		expect(containsExcludedCommand("docker ps && curl evil.com", ["docker:*"])).toBe(true);
		// The second segment on its own does not match the docker exclusion.
		expect(containsExcludedCommand("curl evil.com", ["docker ps"])).toBe(false);
		expect(containsExcludedCommand("curl evil.com", ["docker:*"])).toBe(false);
		// ...and a compound whose only match is in the second segment matches too.
		expect(containsExcludedCommand("echo hi && curl evil.com", ["curl:*"])).toBe(true);
	});

	test("empty exclusion list matches nothing", () => {
		expect(containsExcludedCommand("docker ps", [])).toBe(false);
	});
});

describe("shouldUseSandbox", () => {
	const available = { sandboxAvailable: true };

	test("never sandboxes when the platform/runtime is unavailable", () => {
		expect(shouldUseSandbox({ command: "ls" }, { sandboxAvailable: false })).toBe(false);
	});

	test("sandboxes ordinary commands when available", () => {
		expect(shouldUseSandbox({ command: "ls" }, available)).toBe(true);
		expect(shouldUseSandbox({}, available)).toBe(false);
	});

	test("dangerouslyDisableSandbox honours allowUnsandboxedCommands", () => {
		expect(shouldUseSandbox({ command: "ls", dangerouslyDisableSandbox: true }, available)).toBe(false);
		expect(
			shouldUseSandbox(
				{ command: "ls", dangerouslyDisableSandbox: true },
				{ ...available, allowUnsandboxedCommands: false },
			),
		).toBe(true);
	});

	test("excluded commands opt out", () => {
		expect(
			shouldUseSandbox({ command: "docker ps && curl evil.com" }, { ...available, excludedCommands: ["docker:*"] }),
		).toBe(false);
		expect(shouldUseSandbox({ command: "ls" }, { ...available, excludedCommands: ["docker:*"] })).toBe(true);
	});
});

describe("availability probing", () => {
	test("reports a clean false with a reason on unsupported setups", () => {
		const availability = probeSandboxAvailability(() => false);
		expect(availability.available).toBe(false);
		expect(availability.reason).toBeTruthy();
	});

	test("a throwing probe is reported as unavailable, never propagated", () => {
		const availability = probeSandboxAvailability(() => {
			throw new Error("probe exploded");
		});
		expect(availability.available).toBe(false);
		expect(availability.reason).toContain("probe exploded");
	});

	test("default probe rejects platforms without a sandbox primitive", () => {
		expect(defaultAvailabilityProbe("win32")).toBe(false);
		expect(defaultAvailabilityProbe("freebsd")).toBe(false);
	});

	test("manager degrades: unavailable probe keeps everything disabled", async () => {
		const manager = createSandboxManager({ enabled: true }, { probe: () => false });
		expect(manager.isAvailable()).toBe(false);
		expect(manager.isSandboxingEnabled()).toBe(false);
		expect(manager.isSupportedPlatform()).toBe(false);
		expect(manager.getSandboxUnavailableReason()).toContain("unavailable");
		expect(manager.checkDependencies().errors.length).toBeGreaterThan(0);
		await expect(manager.initialize()).resolves.toBe(false);
		await expect(manager.wrapWithSandbox("ls -la")).resolves.toBe("ls -la");
		// Disabled settings suppress the warning entirely (CC parity).
		const disabled = createSandboxManager({}, { probe: () => false });
		expect(disabled.getSandboxUnavailableReason()).toBeUndefined();
	});

	test("manager with an available platform but no runtime package degrades without throwing", async () => {
		// The real @anthropic-ai/sandbox-runtime is not installed in omp, so
		// initialize() must resolve false and wrapWithSandbox must pass through.
		const manager = createSandboxManager({ enabled: true }, { probe: () => true });
		expect(manager.isSandboxingEnabled()).toBe(true);
		await expect(manager.initialize()).resolves.toBe(false);
		expect(manager.isAvailable()).toBe(false);
		await expect(manager.wrapWithSandbox("echo hi")).resolves.toBe("echo hi");
		expect(manager.getSandboxUnavailableReason()).toBeUndefined();
	});
});

describe("auto-allow predicate for the decision engine", () => {
	test("enabled + available + default autoAllow produces a bash predicate and config", () => {
		const autoAllow = createSandboxAutoAllow(
			{ enabled: true, allowedDomains: ["github.com"], excludedCommands: ["docker:*"] },
			{ probe: () => true },
		);
		expect(autoAllow.availability.available).toBe(true);
		expect(autoAllow.config.network.allowedDomains).toEqual(["github.com"]);
		expect(autoAllow.canSandboxAutoAllow("bash", { command: "npm test" })).toBe(true);
		expect(autoAllow.canSandboxAutoAllow("Bash", { command: "npm test" })).toBe(true);
		expect(autoAllow.shouldUseSandbox({ command: "npm test" })).toBe(true);
	});

	test("non-bash tools, missing commands, and exclusions are not auto-allowed", () => {
		const autoAllow = createSandboxAutoAllow(
			{ enabled: true, excludedCommands: ["docker:*"] },
			{ probe: () => true },
		);
		expect(autoAllow.canSandboxAutoAllow("read", { file_path: "/x" })).toBe(false);
		expect(autoAllow.canSandboxAutoAllow("bash", {})).toBe(false);
		expect(autoAllow.canSandboxAutoAllow("bash", { command: "docker ps && curl evil.com" })).toBe(false);
		expect(autoAllow.canSandboxAutoAllow("bash", { command: "ls", dangerouslyDisableSandbox: true })).toBe(false);
	});

	test("disabled, autoAllowBashIfSandboxed:false, or unavailable platform all veto", () => {
		const disabled = createSandboxAutoAllow({}, { probe: () => true });
		expect(disabled.canSandboxAutoAllow("bash", { command: "ls" })).toBe(false);
		expect(disabled.shouldUseSandbox({ command: "ls" })).toBe(false);

		const noAutoAllow = createSandboxAutoAllow(
			{ enabled: true, autoAllowBashIfSandboxed: false },
			{ probe: () => true },
		);
		expect(noAutoAllow.canSandboxAutoAllow("bash", { command: "ls" })).toBe(false);

		const unavailable = createSandboxAutoAllow({ enabled: true }, { probe: () => false });
		expect(unavailable.canSandboxAutoAllow("bash", { command: "ls" })).toBe(false);
		expect(unavailable.availability.available).toBe(false);
	});
});

describe("addToExcludedCommands", () => {
	test("uses the Bash rule prefix from suggestions, else the literal command", () => {
		expect(
			resolveExcludedCommandPattern("npm run test:*", [
				{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm run test:*" }] },
			]),
		).toBe("npm run test");
		expect(
			resolveExcludedCommandPattern("npm run test", [
				{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm run test" }] },
			]),
		).toBe("npm run test");
		expect(resolveExcludedCommandPattern("docker ps")).toBe("docker ps");
	});

	test("manager keeps a deduplicated internal list", () => {
		const manager = createSandboxManager({ excludedCommands: ["docker:*"] }, { probe: () => false });
		expect(manager.addToExcludedCommands("docker ps")).toBe("docker ps");
		expect(manager.addToExcludedCommands("docker ps")).toBe("docker ps");
		expect(manager.getExcludedCommands()).toEqual(["docker:*", "docker ps"]);
		expect(
			manager.addToExcludedCommands("npm run test", [
				{ type: "addRules", rules: [{ toolName: "bash", ruleContent: "npm run test:*" }] },
			]),
		).toBe("npm run test");
		expect(manager.getExcludedCommands()).toEqual(["docker:*", "docker ps", "npm run test"]);
	});
});

describe("permission rule value parsing (adapter-local copy)", () => {
	test("splits Tool(content) rules and passes bare names through", () => {
		expect(permissionRuleValueFromString("WebFetch(domain:github.com)")).toEqual({
			toolName: "WebFetch",
			ruleContent: "domain:github.com",
		});
		expect(permissionRuleValueFromString("WebFetch")).toEqual({ toolName: "WebFetch" });
	});
});
