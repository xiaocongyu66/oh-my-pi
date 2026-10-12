/**
 * Assembly layer for the skill-evolution system: prepares eval data
 * (harvest → mine → split), runs the trainer, and reports status. Promotion
 * and L2 execution are injected by the caller (slash command / CLI) so this
 * module stays free of TUI and headless-execution dependencies.
 */
import { cfgEvolutionEnabled, cfgEvolutionHeldoutFraction, cfgEvolutionMinTasks } from "./settings";
import { EvolutionStorage } from "./storage";
import { harvestTasks, mineTopic, splitTasks } from "./harvest";
import { trainSkill, type TrainerDeps } from "./trainer";
import { installNightlyScheduler, shouldNightlyRunNow, type NightlyScheduler } from "./schedule";
import { EVOLUTION_MAX_TOKENS, makeTransport, resolveEvolutionModel } from "./transport";
import { cfgEvolutionJudgeModel, cfgEvolutionOptimizerModel } from "./settings";
import { getModelMatchPreferences, resolveAllowedModels } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import type { ModelRegistry } from "../config/model-registry";
import type { EvolutionState, StepRecord, TrainingRunResult } from "./types";

export { EvolutionStorage, getEvolutionRoot, getSkillEvolutionDir, skillVersion } from "./storage";
export type { TrainerDeps, TrainConfig } from "./trainer";

/**
 * Resolve judge/optimizer/target transports from skillEvolution.* settings
 * (empty ids fall back to advisor / default roles). Shared by the /evolve
 * command and the nightly scheduler so both use identical wiring. Storage is
 * created per-run by the trainer, so only the model half of TrainerDeps is
 * returned here.
 */
export async function buildTrainerDeps(
	settings: Settings,
	modelRegistry: ModelRegistry,
): Promise<{ error?: string; deps?: Omit<TrainerDeps, "storage"> }> {
	const preferences = getModelMatchPreferences(settings);
	const allowedModels = await resolveAllowedModels(modelRegistry, settings, preferences);
	const modelDeps = { settings, modelRegistry, allowedModels };
	const judgeModel = resolveEvolutionModel(cfgEvolutionJudgeModel.get(settings), modelDeps);
	const optimizerModel = resolveEvolutionModel(cfgEvolutionOptimizerModel.get(settings), modelDeps);
	const targetModel = resolveEvolutionModel("", modelDeps);
	if (!judgeModel || !optimizerModel || !targetModel) {
		return { error: "could not resolve judge/optimizer/target models (set skillEvolution.judgeModel)" };
	}
	const id = (m: NonNullable<typeof judgeModel>) => `${m.provider}/${m.id}`;
	return {
		deps: {
			target: makeTransport(targetModel, modelRegistry),
			targetModel: id(targetModel),
			judge: makeTransport(judgeModel, modelRegistry, { maxTokens: EVOLUTION_MAX_TOKENS.judge }),
			judgeModel: id(judgeModel),
			optimizer: makeTransport(optimizerModel, modelRegistry, { maxTokens: EVOLUTION_MAX_TOKENS.optimizer }),
			optimizerModel: id(optimizerModel),
		},
	};
}

export interface EvolutionStatus {
	enabled: boolean;
	state: EvolutionState | undefined;
	recentSteps: StepRecord[];
	skillBytes: number | undefined;
}

/** Read-only status for the panel / `/evolve report`. */
export async function getEvolutionStatus(slug: string, settings: Settings): Promise<EvolutionStatus> {
	const storage = new EvolutionStorage(slug, settings.getAgentDir());
	const [state, steps, skill] = await Promise.all([storage.readState(), storage.readSteps(), storage.readSkill()]);
	return {
		enabled: cfgEvolutionEnabled.get(settings),
		state,
		recentSteps: steps.slice(-3),
		skillBytes: skill === undefined ? undefined : Buffer.byteLength(skill, "utf8"),
	};
}

/**
 * Harvest → mine → split, but only when the stored split is missing or
 * empty. Deterministic, so repeated calls with the same session corpus are
 * no-ops.
 */
export async function ensureEvalTasks(
	storage: EvolutionStorage,
	opts: { settings: Settings; minTasks?: number },
): Promise<number> {
	const existing = await storage.readSplit();
	if (existing.train.length + existing.heldout.length > 0) {
		return existing.train.length + existing.heldout.length;
	}
	const harvested = await harvestTasks({ agentDir: opts.settings.getAgentDir() });
	const min = opts.minTasks ?? cfgEvolutionMinTasks.get(opts.settings);
	if (harvested.length < min) {
		return 0;
	}
	// Group by topic; keep topics with at least two members (repeated work),
	// flatten back in topic order so the split is stable per corpus.
	const topics = [...new Set(harvested.map(t => t.topic))];
	const mined = topics.flatMap(topic =>
		mineTopic(
			harvested.filter(t => t.topic === topic),
			harvested,
			2,
		),
	);
	const fraction = cfgEvolutionHeldoutFraction.get(opts.settings);
	const split = splitTasks(mined, fraction);
	await storage.writeSplit(split);
	await storage.appendLedger({
		ts: new Date().toISOString(),
		event: "harvest",
		skill: storage.slug,
		detail: `${split.train.length} train / ${split.heldout.length} heldout from ${harvested.length} harvested`,
	});
	return split.train.length + split.heldout.length;
}

export interface RunTrainingOptions extends Omit<TrainerDeps, "storage"> {
	slug: string;
	settings: Settings;
}

/** Prepare eval data, then run the training loop. */
export async function runTraining(options: RunTrainingOptions): Promise<TrainingRunResult> {
	const { slug, settings, ...deps } = options;
	const storage = new EvolutionStorage(slug, settings.getAgentDir());
	await storage.ensureRoot();
	const total = await ensureEvalTasks(storage, { settings });
	if (total === 0) {
		return {
			skill: slug,
			steps: [],
			promoted: false,
			reason: "error",
			bestVersion: "",
			error: "not enough harvested tasks to train (raise sessions or lower skillEvolution.minTasks)",
		};
	}
	return trainSkill({ ...deps, storage });
}

// ─── Nightly scheduling ──────────────────────────────────────────────────────

let nightlyScheduler: NightlyScheduler | undefined;

/**
 * Install (once per process) the nightly evolution tick. Each tick re-checks
 * `skillEvolution.enabled` + `schedule.enabled` + the due time against the
 * persisted last-run date, so toggling settings mid-session just works.
 */
export function ensureNightlyEvolutionScheduler(settings: Settings, run: () => Promise<unknown>): void {
	if (nightlyScheduler) return;
	nightlyScheduler = installNightlyScheduler({ settings, run });
}

/** Due-check shared with the tick — callers invoke their own training runner. */
export async function maybeRunNightly(settings: Settings, run: () => Promise<TrainingRunResult>): Promise<boolean> {
	const storage = new EvolutionStorage("default", settings.getAgentDir());
	const state = await storage.readState();
	if (!shouldNightlyRunNow(settings, state?.lastRunDate)) return false;
	await run();
	return true;
}
