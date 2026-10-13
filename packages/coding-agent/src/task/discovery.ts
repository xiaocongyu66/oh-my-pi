/**
 * Agent discovery from filesystem.
 *
 * Discovers agent definitions from task-agent roots:
 *   - ~/.omp/agent/agents/*.md (user-level, OMP-native)
 *   - .claude/agents/*.md (project-level). The project config directory is
 *     `.claude/` (omp took over Claude Code's convention); files there follow
 *     the Claude Code agent dialect (`name`/`description`/`tools`/`model` with
 *     Claude aliases), so a Claude-dialect `model:` is downgraded (dropped)
 *     during load — OMP-dialect files written by `omp agents unpack --project`
 *     keep their selectors.
 *   - the legacy `.omp/agents/*.md` directory, read only when no `.claude`
 *     project agents directory exists (fallback so existing projects do not
 *     silently lose agents)
 *   - <ext>/agents/*.md for every OMP extension package wired through
 *     `listOmpExtensionRoots` (CLI `--extension` roots, `extensions:` in
 *     settings, and enabled npm/link plugins under `<plugins>/node_modules/`).
 *     Mirrors the same sub-discovery convention applied to `skills/`,
 *     `hooks/`, `tools/`, etc. by `discovery/omp-plugins.ts`.
 *
 * Claude Code marketplace plugin agents are discovered separately via the
 * claude-plugins provider.
 *
 * Agent files use markdown with YAML frontmatter.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger, parseFrontmatter } from "@oh-my-pi/pi-utils";
import { isProviderEnabled, isUserSourceEnabled } from "../capability";
import type { EffectiveExtensionRoots } from "../capability/types";
import { findAllNearestProjectConfigDirs, getConfigDirs } from "../config";
import { agentFrontmatterUsesClaudeModelDialect, pluginUsesClaudeModelDialect } from "../discovery/agent-plugin-format";
import { listClaudePluginRoots } from "../discovery/helpers";
import { listOmpExtensionRoots } from "../discovery/omp-extension-roots";
import { loadBundledAgents, parseAgent } from "./agents";
import type { AgentSource } from "@oh-my-pi/pi-tui/tools/task";
import type { AgentDefinition } from "./types";

/** User-level task-agent source: the untouched `~/.omp` user config home. */
const TASK_AGENT_USER_CONFIG_SOURCE = ".omp";
/** Project-level task-agent source: the `.claude/` project config directory. */
const TASK_AGENT_PROJECT_CONFIG_SOURCE = ".claude";
/** Legacy project source, read only when `.claude/agents` does not exist. */
const LEGACY_TASK_AGENT_PROJECT_CONFIG_SOURCE = ".omp";

/** One-shot notice when project agents are only found under the legacy `.omp/` directory. */
let warnedLegacyProjectAgents = false;
function warnLegacyProjectAgentsOnce(dir: string): void {
	if (warnedLegacyProjectAgents) return;
	warnedLegacyProjectAgents = true;
	logger.warn("Project agents found under deprecated .omp/agents; move them to .claude/agents", { path: dir });
}

/** Result of agent discovery */
export interface DiscoveryResult {
	agents: AgentDefinition[];
	projectAgentsDir: string | null;
	/** Agent directories searched, in precedence order (for "unknown agent" diagnostics). */
	searchedDirs?: string[];
}

interface AgentDirectory {
	dir: string;
	source: AgentSource;
	ignoreModel?: boolean;
	/**
	 * Directory owned by Claude Code (project `.claude/agents`). Files there are
	 * usually Claude-dialect (`model:` holds a Claude alias); per-file
	 * detection keeps OMP-dialect files (written by `omp agents unpack
	 * --project`) intact while dropping aliases from the rest (#7966).
	 */
	claudeRoot?: boolean;
}

/**
 * Load agents from a directory.
 */
async function loadAgentsFromDir({ dir, source, ignoreModel, claudeRoot }: AgentDirectory): Promise<AgentDefinition[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
	const files = entries
		.filter(entry => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map(file => {
			const filePath = path.join(dir, file.name);
			return fs
				.readFile(filePath, "utf-8")
				.then(content => {
					const agent = parseAgent(filePath, content, source, "warn");
					if (ignoreModel) {
						agent.model = undefined;
					} else if (claudeRoot) {
						// Claude-dialect frontmatter: the `model:` value is a Claude
						// alias (`sonnet`/`opus`/…), never an OMP selector — drop it.
						// CC honors the alias; omp cannot resolve it, so the drop is
						// surfaced as a warning instead of silently changing cost.
						const { frontmatter } = parseFrontmatter(content, { location: filePath, level: "off" });
						if (agentFrontmatterUsesClaudeModelDialect(frontmatter)) {
							if (agent.model) {
								logger.warn("Project agent uses a Claude model alias; falling back to the active model", {
									filePath,
									model: agent.model,
								});
							}
							agent.model = undefined;
						}
					}
					return agent;
				})
				.catch(error => {
					logger.warn("Failed to read agent file", { filePath, error });
					return null;
				});
		});

	return (await Promise.all(files)).filter(Boolean) as AgentDefinition[];
}

/**
 * Discover agents from filesystem and merge with bundled agents.
 * Precedence (highest wins): project `.claude/agents` (legacy `.omp/agents`
 * only as fallback), user `~/.omp/agent/agents`, OMP extension-package agents
 * from the effective `extensions` setting, installed npm/link plugins, Claude
 * marketplace plugin agents (project scope before user), then bundled.
 * @param cwd - Current working directory for project agent discovery
 * @param home - Home directory for user and marketplace discovery
 * @param extensionRoots - Session-local extension roots (explicit + mode + configured)
 */
export async function discoverAgents(
	cwd: string,
	home: string = os.homedir(),
	extensionRoots?: EffectiveExtensionRoots,
): Promise<DiscoveryResult> {
	const resolvedCwd = path.resolve(cwd);

	const userDirs = getConfigDirs("agents", { project: false })
		.filter(entry => entry.source === TASK_AGENT_USER_CONFIG_SOURCE)
		.map(entry => ({
			...entry,
			path: path.resolve(entry.path),
		}));

	// Project agents come from `.claude/agents`; the legacy `.omp/agents` is a
	// fallback used only when no `.claude` project agents directory exists.
	const nearestProjectDirs = findAllNearestProjectConfigDirs("agents", resolvedCwd);
	const projectDirs = nearestProjectDirs.filter(entry => entry.source === TASK_AGENT_PROJECT_CONFIG_SOURCE);
	if (projectDirs.length === 0) {
		const legacyDirs = nearestProjectDirs.filter(entry => entry.source === LEGACY_TASK_AGENT_PROJECT_CONFIG_SOURCE);
		if (legacyDirs.length > 0) warnLegacyProjectAgentsOnce(legacyDirs[0].path);
		projectDirs.push(...legacyDirs);
	}
	const projectDirEntries = projectDirs.map(entry => ({ ...entry, path: path.resolve(entry.path) }));
	const legacyProject = projectDirEntries[0]?.source === LEGACY_TASK_AGENT_PROJECT_CONFIG_SOURCE;

	const orderedDirs: AgentDirectory[] = [];
	const project = projectDirEntries[0];
	if (project) {
		orderedDirs.push({ dir: project.path, source: "project", claudeRoot: !legacyProject });
	}
	const user = userDirs[0];
	if (user) orderedDirs.push({ dir: user.path, source: "user" });

	// Extension-package agents use the same effective root set as sibling
	// skills/hooks/tools, threaded whole so explicit roots and mode survive.
	const packageRoots = isProviderEnabled("omp-plugins")
		? await listOmpExtensionRoots({ cwd: resolvedCwd, home, repoRoot: null, extensionRoots })
		: [];
	for (const root of packageRoots) {
		orderedDirs.push({ dir: path.join(root.path, "agents"), source: root.level });
	}

	// Load agents from Claude Code marketplace plugins (respects disabledProviders and opt-in).
	// User-scope roots whose origin is not the foreign ~/.claude/plugins tree (omp's own
	// installs and `--plugin-dir` roots) survive the claude-plugins opt-in gate, mirroring
	// isSourceEnabled in extensibility/skills.ts (#10743). Without this, `--plugin-dir` and
	// omp-installed agents are dropped at user scope whenever the Claude source is disabled.
	const claudePluginsUserEnabled = isUserSourceEnabled("claude-plugins") || isUserSourceEnabled("claude");
	const { roots: pluginRoots } = isProviderEnabled("claude-plugins")
		? await listClaudePluginRoots(home, resolvedCwd)
		: { roots: [] };
	const filteredPluginRoots = pluginRoots.filter(
		r => r.scope === "project" || claudePluginsUserEnabled || r.origin !== "claude",
	);
	const sortedPluginRoots = [...filteredPluginRoots].sort((a, b) => {
		if (a.scope === b.scope) return 0;
		return a.scope === "project" ? -1 : 1;
	});
	const pluginModelDrops = await Promise.all(
		// The `model:` dialect follows the plugin's declared manifest, not the
		// registry that supplied it: foreign Claude roots (origin "claude") always
		// use Claude aliases, and an omp-installed or --plugin-dir root can still
		// ship a `.claude-plugin` package. Claude-dialect frontmatter is dropped so
		// its aliases are not misread as OMP selectors (#7966); OMP-native and
		// Agent-Plugins-standard plugin agents keep their selectors (#12028).
		sortedPluginRoots.map(
			async plugin => plugin.origin === "claude" || (await pluginUsesClaudeModelDialect(plugin.path)),
		),
	);
	sortedPluginRoots.forEach((plugin, index) => {
		orderedDirs.push({
			dir: path.join(plugin.path, "agents"),
			source: plugin.scope === "project" ? "project" : "user",
			ignoreModel: pluginModelDrops[index],
		});
	});

	const seen = new Set<string>();
	const loadedAgents = (await Promise.all(orderedDirs.map(loadAgentsFromDir))).flat().filter(agent => {
		if (seen.has(agent.name)) return false;
		seen.add(agent.name);
		return true;
	});

	const bundledAgents = loadBundledAgents().filter(agent => {
		if (seen.has(agent.name)) return false;
		seen.add(agent.name);
		return true;
	});

	const projectAgentsDir = projectDirEntries.length > 0 ? projectDirEntries[0].path : null;

	return {
		agents: [...loadedAgents, ...bundledAgents],
		projectAgentsDir,
		searchedDirs: orderedDirs.map(entry => entry.dir),
	};
}

/**
 * Get an agent by name from discovered agents.
 */
export function getAgent(agents: AgentDefinition[], name: string): AgentDefinition | undefined {
	return agents.find(a => a.name === name);
}
