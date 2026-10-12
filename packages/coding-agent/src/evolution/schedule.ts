/**
 * Nightly scheduler for the evolution trainer (SkillOpt-Sleep's "run while
 * the machine is idle" idea, scoped to an open omp session): fires at most
 * once per local day at/after the configured HH:MM while omp stays open,
 * deduped via `state.json lastRunDate`. No OS cron, no timers piling up —
 * one interval tick checks the wall clock and the persisted last-run date.
 */
import { cfgEvolutionEnabled, cfgEvolutionScheduleEnabled, cfgEvolutionScheduleTime } from "./settings";
import type { Settings } from "../config/settings";

const TICK_MS = 60_000;

/** LOCAL-day stamp matching the local HH:MM schedule semantics (the old
 *  UTC slice mixed calendars and could double-fire around midnight). */
export function localDatestamp(now = new Date()): string {
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

export function parseScheduleTime(hhmm: string): { hours: number; minutes: number } | undefined {
	const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
	if (!m) return undefined;
	const hours = Number(m[1]);
	const minutes = Number(m[2]);
	if (hours > 23 || minutes > 59) return undefined;
	return { hours, minutes };
}

/** Whether the nightly run is due right now for the given last-run date. */
export function isNightlyDue(now: Date, lastRunDate: string | undefined, hhmm: string): boolean {
	const parsed = parseScheduleTime(hhmm);
	if (!parsed) return false;
	if (lastRunDate === localDatestamp(now)) return false;
	const minutesNow = now.getHours() * 60 + now.getMinutes();
	const minutesDue = parsed.hours * 60 + parsed.minutes;
	return minutesNow >= minutesDue;
}

export interface NightlyScheduler {
	stop: () => void;
}

/** Install the nightly tick. Returns a stop handle; no-op when disabled. */
export function installNightlyScheduler(opts: {
	settings: Settings;
	run: () => Promise<unknown>;
	timer?: { setInterval: typeof setInterval; clearInterval: typeof clearInterval };
}): NightlyScheduler {
	const timers = opts.timer ?? { setInterval, clearInterval };
	let stopped = false;
	let running = false;
	const handle = timers.setInterval(() => {
		if (stopped || running) return;
		if (!cfgEvolutionEnabled.get(opts.settings) || !cfgEvolutionScheduleEnabled.get(opts.settings)) return;
		void (async () => {
			running = true;
			try {
				await opts.run();
			} finally {
				running = false;
			}
		})();
	}, TICK_MS);
	return {
		stop: () => {
			stopped = true;
			timers.clearInterval(handle);
		},
	};
}

/** Shared due-check used by the run entrypoint (keeps scheduler dumb). */
export function shouldNightlyRunNow(settings: Settings, lastRunDate: string | undefined, now = new Date()): boolean {
	if (!cfgEvolutionEnabled.get(settings) || !cfgEvolutionScheduleEnabled.get(settings)) return false;
	return isNightlyDue(now, lastRunDate, cfgEvolutionScheduleTime.get(settings));
}
