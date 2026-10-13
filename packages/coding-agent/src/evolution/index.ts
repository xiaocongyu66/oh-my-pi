/**
 * Assembly layer for the skill-evolution system: prepares eval data
 * (harvest → mine → split), runs the trainer, and reports status. Promotion
 * and L2 execution are injected by the caller (slash command / CLI) so this
 * module stays free of TUI and headless-execution dependencies.
 */
import { cfgEvolutionEnabled, cfgEvolutionHeldoutFraction, cfgEvolutionMinTasks, cfgEvolutionApprovalModel } from "./settings";
import { EvolutionStorage } from "./storage";
import { harvestTasks, mineTopic, splitTasks } from "./harvest";
import { trainSkill, type TrainerDeps } from "./trainer";
import { installNightlyScheduler, shouldNightlyRunNow, localDatestamp, type NightlyScheduler } from "./schedule";
import { rollbackEvolutionLock, tryAcquireEvolutionLock } from "./lock";
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
/** Approval-review model for the L2 sandbox: dedicated cfg, else the judge model. */
export function resolveApprovalModelId(settings: Settings, judgeModelId: string): string {
	const configured = cfgEvolutionApprovalModel.get(settings).trim();
	return configured || judgeModelId;
}

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

/** Prepare eval data, then run the training loop under the cross-process lock. */
export async function runTraining(options: RunTrainingOptions): Promise<TrainingRunResult> {
	const { slug, settings, ...deps } = options;
	const agentDir = settings.getAgentDir();
	// Shared mutex for manual /evolve train and the nightly tick: concurrent
	// campaigns for one slug corrupted state.json (probe-confirmed ENOENT).
	const priorMtime = await tryAcquireEvolutionLock(slug, agentDir);
	if (priorMtime === null) {
		return {
			skill: slug,
			steps: [],
			promoted: false,
			reason: "error",
			bestVersion: "",
			error: `training already running for ${slug}`,
		};
	}
	try {
		const storage = new EvolutionStorage(slug, agentDir);
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
		return await trainSkill({ ...deps, storage });
	} finally {
		await rollbackEvolutionLock(slug, agentDir, priorMtime);
	}
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

/**
 * Due-check shared with the tick — callers invoke their own training runner.
 * Failure discipline (review S3): a failed or lock-blocked nightly still
 * stamps `lastRunDate`, or the next 60s tick re-runs the entire night.
 */
export async function maybeRunNightly(settings: Settings, run: () => Promise<TrainingRunResult>): Promise<boolean> {
	const storage = new EvolutionStorage("default", settings.getAgentDir());
	const state = await storage.readState();
	if (!shouldNightlyRunNow(settings, state?.lastRunDate)) return false;
	try {
		const result = await run();
		if (result.reason === "error" && result.error?.includes("already running")) {
			await stampNightlyAttempt(storage);
		}
	} catch (error) {
		await stampNightlyAttempt(storage);
		throw error;
	}
	return true;
}

/** Nightly treats "attempted" as "ran" — record today so we don't retry tonight. */
async function stampNightlyAttempt(storage: EvolutionStorage): Promise<void> {
	const current = await storage.readState();
	await storage.writeState({
		...(current ?? {
			skill: "default",
			version: "v0",
			bestVersion: "v0",
			step: 0,
			bestStep: 0,
			currentScore: -1,
			bestScore: -1,
			rejectedBuffer: [],
			lastRunDate: undefined,
			status: "idle" as const,
		}),
		lastRunDate: localDatestamp(),
	});
}
