import { describe, expect, it } from "bun:test";

import { isNightlyDue, parseScheduleTime } from "../../src/evolution/schedule";

describe("nightly schedule", () => {
	it("parses strict HH:MM", () => {
		expect(parseScheduleTime("02:30")).toEqual({ hours: 2, minutes: 30 });
		expect(parseScheduleTime("23:59")).toEqual({ hours: 23, minutes: 59 });
		expect(parseScheduleTime("24:00")).toBeUndefined();
		expect(parseScheduleTime("2:5")).toBeUndefined();
		expect(parseScheduleTime("soon")).toBeUndefined();
	});

	it("fires at/after the configured time, once per local day", () => {
		const at = (h: number, m: number) =>
			new Date(`2026-10-13T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`);
		expect(isNightlyDue(at(2, 30), undefined, "02:30")).toBe(true);
		expect(isNightlyDue(at(3, 0), undefined, "02:30")).toBe(true); // later same day
		expect(isNightlyDue(at(1, 0), undefined, "02:30")).toBe(false); // too early
		expect(isNightlyDue(at(3, 0), "2026-10-13", "02:30")).toBe(false); // already ran today
		expect(isNightlyDue(at(3, 0), "2026-10-12", "02:30")).toBe(true); // ran yesterday
	});
});
