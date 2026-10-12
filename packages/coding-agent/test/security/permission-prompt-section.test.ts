/**
 * Contract: the system prompt carries a permission briefing whose mode
 * paragraph matches the effective mode (explicit setting or legacy mapping),
 * always includes the never-retry-a-denial guidance, and stays silent only
 * for modes blocked by policy.
 */
import { describe, expect, test } from "bun:test";
import { Settings } from "../../src/config/settings";
import { buildPermissionModeInstructions } from "../../src/security/prompt-section";

function section(config: Record<string, unknown>): string | undefined {
	return buildPermissionModeInstructions(Settings.isolated(config));
}

describe("buildPermissionModeInstructions", () => {
	test("legacy always-ask maps to the default briefing", () => {
		const text = section({ "tools.approvalMode": "always-ask" });
		expect(text).toBeDefined();
		expect(text).toContain("Current mode: default.");
		expect(text).toContain("## Permission System");
		expect(text).toContain("Never retry a denied call unchanged");
	});

	test("legacy write maps to acceptEdits", () => {
		expect(section({ "tools.approvalMode": "write" })).toContain("Current mode: acceptEdits.");
	});

	test("legacy yolo maps to bypassPermissions", () => {
		const text = section({ "tools.approvalMode": "yolo" });
		expect(text).toContain("Current mode: bypassPermissions.");
		expect(text).toContain("bypass-immune safety checks");
	});

	test("explicit permissions.defaultMode wins over the legacy mode", () => {
		const text = section({ "tools.approvalMode": "yolo", "permissions.defaultMode": "plan" });
		expect(text).toContain("Current mode: plan.");
		expect(text).toContain("work read-only");
	});

	test("every permitted mode has a briefing", () => {
		const modes = ["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk"] as const;
		for (const mode of modes) {
			const text = section({ "permissions.defaultMode": mode });
			expect(text, `mode ${mode}`).toBeDefined();
			expect(text, `mode ${mode}`).toContain(`Current mode: ${mode}.`);
		}
	});

	test("auto mode is briefed when the classifier is enabled", () => {
		const text = section({ "permissions.defaultMode": "auto", "permissions.classifier": true });
		expect(text).toContain("Current mode: auto.");
		expect(text).toContain("safety classifier");
	});

	test("auto mode falls back to the default briefing without a classifier", () => {
		expect(section({ "permissions.defaultMode": "auto", "permissions.classifier": false })).toContain(
			"Current mode: default.",
		);
	});

	test("disabled bypass mode never gets the bypass briefing", () => {
		const text = section({
			"permissions.defaultMode": "bypassPermissions",
			"permissions.disableBypassPermissionsMode": true,
		});
		expect(text).toContain("Current mode: default.");
	});
});
