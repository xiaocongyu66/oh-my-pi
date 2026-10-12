/**
 * End-to-end regression for the bypass approval authority: under
 * bypassPermissions the security engine (evaluateCcPermissions) must STILL
 * receive settings and run its bypass-immune pipeline (deny rules, safety
 * checks). A refactor that suppresses the call again (the ccEnabled
 * `approvalMode !== "yolo"` stand-down bug) must fail here.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

describe("wrapper bypass end-to-end (security engine stays authoritative)", () => {
	let tempDir: TempDir;
	let extensionsDir: string;
	let sessionManager: SessionManager;

	beforeEach(() => {
		tempDir = TempDir.createSync("@wrapper-bypass-");
		extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		sessionManager = SessionManager.inMemory();
	});

	afterEach(() => {
		tempDir.removeSync();
	});

	async function buildWrappedTool() {
		fs.writeFileSync(
			path.join(extensionsDir, "probe.ts"),
			`
			export default function(pi) {
				const { Type } = pi.typebox;
				pi.registerTool({
					name: "probe_tool",
					label: "Probe",
					description: "bypass probe",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "RAN" }], details: {} }),
				});
			}
			`,
		);
		const probeFile = path.join(extensionsDir, "probe.ts");
		const result = await loadExtensions([probeFile], tempDir.path());
		const runner = new ExtensionRunner(
			result.extensions,
			result.runtime,
			tempDir.path(),
			sessionManager,
			new ModelRegistry(await AuthStorage.create(path.join(tempDir.path(), "auth.db"))),
		);
		const registered = runner.getAllRegisteredTools().at(0);
		if (!registered) throw new Error(`probe tool not registered: ${JSON.stringify(result.errors)}`);
		// definition carries the extension's execute; the wrapper adds approval.
		return new ExtensionToolWrapper(
			registered.definition as unknown as ConstructorParameters<typeof ExtensionToolWrapper>[0],
			runner,
		);
	}

	it("bypass settings still reach the engine: a deny rule blocks the call even in bypassPermissions", async () => {
		const wrapped = await buildWrappedTool();
		const settings = Settings.isolated({ "tools.approvalMode": "yolo", "permissions.deny": ["probe_tool"] });
		await expect(
			wrapped.execute("test-call-1", {}, undefined, undefined, {
				settings,
				hasUI: () => false,
			} as never),
		).rejects.toThrow(/denied|deny/i);
	});
});
