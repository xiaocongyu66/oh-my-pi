/**
 * `/evolve` — operator surface for the skill-evolution trainer:
 *
 *   /evolve [status]         show trainer state + recent steps
 *   /evolve train [slug]     harvest (if needed) + train, background-dispatched
 *   /evolve stop             cancel the running training
 *   /evolve report           recent ledger entries
 *   /evolve set <key> <val>  update skillEvolution.* settings
 *
 * The TUI panel (evolution-panel overlay) opens through `/evolve panel`.
 * Every operator-visible string goes through t(); L2 verification and
 * promotion are wired in the runner below.
 */
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import { t } from "@oh-my-pi/pi-i18n";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime, SlashCommandSpec } from "./types";

import { getEvolutionStatus, runTraining, buildTrainerDeps, EvolutionStorage, getEvolutionRoot } from "../evolution";
import { runL2Verification } from "../evolution/l2";
import { promoteSkill } from "../evolution/promotion";
import {
	cfgEvolutionEnabled,
	cfgEvolutionJudgeModel,
	cfgEvolutionOptimizerModel,
	cfgEvolutionMaxEpochs,
	cfgEvolutionLearningRate,
	cfgEvolutionEditBudgetTokens,
	cfgEvolutionEarlyStopEpochs,
	cfgEvolutionL2SampleSize,
	cfgEvolutionL2TimeoutSec,
	cfgEvolutionScheduleEnabled,
	cfgEvolutionScheduleTime,
} from "../evolution/settings";

/** One cancel handle per slug; `/evolve stop` aborts the active run. */
const activeRuns = new Map<string, AbortController>();

/** L2 batch passes when mean hard-fraction reaches this (aggregate_scores + gate discipline). */
const L2_PASS_THRESHOLD = 0.5;

const SETTING_KEYS = new Set([
	"enabled",
	"judgeModel",
	"optimizerModel",
	"maxEpochs",
	"learningRate",
	"editBudgetTokens",
	"earlyStopEpochs",
	"schedule.enabled",
	"schedule.time",
]);

function settingFor(key: string) {
	switch (key) {
		case "enabled":
			return cfgEvolutionEnabled;
		case "judgeModel":
			return cfgEvolutionJudgeModel;
		case "optimizerModel":
			return cfgEvolutionOptimizerModel;
		case "maxEpochs":
			return cfgEvolutionMaxEpochs;
		case "learningRate":
			return cfgEvolutionLearningRate;
		case "editBudgetTokens":
			return cfgEvolutionEditBudgetTokens;
		case "earlyStopEpochs":
			return cfgEvolutionEarlyStopEpochs;
		case "schedule.enabled":
			return cfgEvolutionScheduleEnabled;
		case "schedule.time":
			return cfgEvolutionScheduleTime;
		default:
			return undefined;
	}
}

async function handleStatus(runtime: SlashCommandRuntime, slug: string): Promise<SlashCommandResult> {
	const status = await getEvolutionStatus(slug, runtime.settings);
	if (!status.state && status.skillBytes === undefined) {
		await runtime.output(t(`No evolution data for "{{slug}}" yet — run /evolve train ${slug}.`, { slug }));
		return commandConsumed();
	}
	const s = status.state;
	const lines = [
		t(
			`Evolution "{{slug}}": {{status}}, step {{step}}, current score {{current}}, best {{best}} (step {{bestStep}})`,
			{
				slug,
				status: s?.status ?? "idle",
				step: s?.step ?? 0,
				current: (s?.currentScore ?? -1).toFixed(3),
				best: (s?.bestScore ?? -1).toFixed(3),
				bestStep: s?.bestStep ?? 0,
			},
		),
	];
	for (const step of status.recentSteps) {
		lines.push(
			t(`  step {{step}}: {{action}} gate={{gate}} train {{trainHard}}/{{trainSoft}}`, {
				step: step.step,
				action: step.action,
				gate: step.gateAction,
				trainHard: step.trainHard.toFixed(2),
				trainSoft: step.trainSoft.toFixed(2),
			}),
		);
	}
	await runtime.output(lines.join("\n"));
	return commandConsumed();
}

async function handleTrain(runtime: SlashCommandRuntime, slug: string): Promise<SlashCommandResult> {
	if (!cfgEvolutionEnabled.get(runtime.settings)) {
		return usage(t("Skill evolution is disabled — run /evolve set enabled true first."), runtime);
	}
	if (activeRuns.has(slug)) {
		await runtime.output(t(`Training for "{{slug}}" is already running.`, { slug }));
		return commandConsumed();
	}
	const controller = new AbortController();
	activeRuns.set(slug, controller);

	const run = async (): Promise<void> => {
		try {
			const wired = await buildTrainerDeps(runtime.settings, runtime.session.modelRegistry);
			if (wired.error || !wired.deps) {
				await runtime.output(
					t("Could not resolve judge/optimizer/target models — {{err}}", { err: wired.error ?? "" }),
				);
				return;
			}
			await runtime.output(
				t(`Training "{{slug}}" (judge {{judge}}, optimizer {{optimizer}})...`, {
					slug,
					judge: wired.deps.judgeModel,
					optimizer: wired.deps.optimizerModel,
				}),
			);
			// L2 (real execution) then promotion — both stage-gated by the trainer.
			const storage = new EvolutionStorage(slug, runtime.settings.getAgentDir());
			const result = await runTraining({
				slug,
				settings: runtime.settings,
				...wired.deps,
				signal: controller.signal,
				onL2Verify: async (_bestSkill, split) => {
					const tasks = split.heldout.slice(0, cfgEvolutionL2SampleSize.get(runtime.settings));
					const verdict = await runL2Verification(tasks, {
						judge: wired.deps.judge,
						judgeModel: wired.deps.judgeModel,
						opts: {
							timeoutMs: cfgEvolutionL2TimeoutSec.get(runtime.settings) * 1000,
							workdir: runtime.cwd,
							passThreshold: L2_PASS_THRESHOLD,
						},
						signal: controller.signal,
						storage,
					});
					return verdict.passed;
				},
				onPromoted: async (bestSkill, state) => {
					await promoteSkill({
						slug,
						description: `Trained skill (validation gate ${state.bestScore.toFixed(3)} at step ${state.bestStep})`,
						body: bestSkill,
						provenance: {
							skill: slug,
							epochs: state.step,
							validationScoreBefore: -1,
							validationScoreAfter: state.bestScore,
							gateAction: "accept_new_best",
							bestScore: state.bestScore,
							bestStep: state.bestStep,
							l2AvgQuality: undefined,
							promotedAt: new Date().toISOString(),
						},
					});
				},
				config: {
					maxEpochs: cfgEvolutionMaxEpochs.get(runtime.settings),
					learningRate: cfgEvolutionLearningRate.get(runtime.settings),
					editBudgetTokens: cfgEvolutionEditBudgetTokens.get(runtime.settings),
					earlyStopSteps: cfgEvolutionEarlyStopEpochs.get(runtime.settings),
				},
			});
			await runtime.output(
				t(`Training finished: {{reason}} ({{steps}} steps, best {{best}})`, {
					reason: result.reason,
					steps: result.steps.length,
					best: result.bestVersion || "—",
				}),
			);
		} catch (error) {
			await runtime.output(t(`Training failed: {{err}}`, { err: errorMessage(error) }));
		} finally {
			activeRuns.delete(slug);
		}
	};
	if (runtime.runCommandInBackground) {
		runtime.runCommandInBackground(run);
		return commandConsumed();
	}
	await run();
	return commandConsumed();
}

async function handleReport(runtime: SlashCommandRuntime, slug: string): Promise<SlashCommandResult> {
	const storage = new EvolutionStorage(slug, runtime.settings.getAgentDir());
	const ledger = await storage.readLedger();
	const recent = ledger.slice(-12);
	if (recent.length === 0) {
		await runtime.output(t(`No ledger entries yet for "{{slug}}".`, { slug }));
		return commandConsumed();
	}
	await runtime.output(
		[
			getEvolutionRoot(runtime.settings.getAgentDir()),
			...recent.map(e => `${e.ts} ${e.event}${e.step !== undefined ? ` #${e.step}` : ""} ${e.detail}`),
		].join("\n"),
	);
	return commandConsumed();
}

async function handleEvolve(command: ParsedSlashCommand, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const parts = command.args.trim().split(/\s+/).filter(Boolean);
	const sub = parts[0] ?? "status";
	const slug = parts[1] ?? "default";

	if (sub === "status") return handleStatus(runtime, parts[1] ? slug : "default");
	if (sub === "train") return handleTrain(runtime, slug);
	if (sub === "stop") {
		const handle = activeRuns.get(slug);
		if (!handle) {
			await runtime.output(t(`No active training for "{{slug}}".`, { slug }));
			return commandConsumed();
		}
		handle.abort();
		await runtime.output(t(`Stopping training for "{{slug}}"...`, { slug }));
		return commandConsumed();
	}
	if (sub === "report") return handleReport(runtime, slug);
	if (sub === "set") {
		const key = parts[1];
		const value = parts.slice(2).join(" ");
		if (!key || !SETTING_KEYS.has(key) || !value) {
			return usage(
				t("Usage: /evolve set <{{keys}}> <value>", {
					keys: [...SETTING_KEYS].join("|"),
				}),
				runtime,
			);
		}
		const def = settingFor(key);
		if (!def) return usage(t("Unknown setting {{key}}", { key }), runtime);
		let parsed: string | number | boolean = value;
		if (def.type === "number") {
			parsed = Number(value);
			if (!Number.isFinite(parsed)) return usage(t("{{key}} needs a number", { key }), runtime);
		} else if (def.type === "boolean") {
			parsed = value === "true" || value === "1" || value === "on";
		}
		runtime.settings.writeValue(def, parsed, "global");
		await runtime.output(t("{{key}} = {{value}}", { key, value: String(parsed) }));
		return commandConsumed();
	}
	return usage(t("Usage: /evolve [status|train <slug>|stop|report|set <key> <value>]"), runtime);
}

export const BUILTIN_EVOLVE_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "evolve",
		description: "Skill-evolution trainer: status, train, stop, report, settings",
		allowArgs: true,
		execute: handleEvolve,
	},
];
