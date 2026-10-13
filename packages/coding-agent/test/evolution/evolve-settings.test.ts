import { describe, expect, it } from "bun:test";
import { Settings, resetSettingsForTest } from "../../src/config/settings";
import { resolveApprovalModelId } from "../../src/evolution";

describe("resolveApprovalModelId", () => {
	it("returns the dedicated approval model when configured", () => {
		resetSettingsForTest();
		const settings = Settings.isolated({ "skillEvolution.approvalModel": "reviewer/model-x" });
		expect(resolveApprovalModelId(settings, "judge/fallback")).toBe("reviewer/model-x");
		resetSettingsForTest();
	});

	it("falls back to the judge model when the cfg is empty or blank", () => {
		resetSettingsForTest();
		const settings = Settings.isolated({ "skillEvolution.approvalModel": "   " });
		expect(resolveApprovalModelId(settings, "judge/fallback")).toBe("judge/fallback");
		resetSettingsForTest();
	});
});
