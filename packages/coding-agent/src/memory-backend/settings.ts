/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

// Memory backend selector — picks between local memories pipeline,
// Mnemopi local SQLite, Hindsight remote memory, Sharpshooter project
// decisions, Claude-Style MEMORY.md + topic files, or off. The legacy
// `memories.enabled` flag is migration input only; see config/settings.ts.
// Protocol hosts (RPC/ACP) start with memory off: embedders opt in through their own settings layer.
export const cfgMemoryBackend = register({
	id: "memory.backend",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: ["off", "local", "hindsight", "mnemopi", "sharpshooter", "claudemd"] as const,
	default: "off",
	ui: {
		tab: "memory",
		group: "General",
		label: "Memory Backend",
		description:
			"Off, local summary pipeline, Mnemopi SQLite, Hindsight remote memory, Sharpshooter, or Claude-Style MEMORY.md",
		options: [
			{ value: "off", label: "Off", description: "No memory subsystem runs" },
			{ value: "local", label: "Local", description: "Local rollout summarisation pipeline (memory_summary.md)" },
			{ value: "hindsight", label: "Hindsight", description: "Vectorize Hindsight remote memory service" },
			{
				value: "mnemopi",
				label: "Mnemopi",
				description: "Local SQLite recall/retain backend with optional embeddings",
			},
			{
				value: "sharpshooter",
				label: "Sharpshooter",
				description:
					"Friction-gated project decision files (architecture/product/style), consolidated in the background",
			},
			{
				value: "claudemd",
				label: "Claude-Style",
				description:
					"Claude Code-style MEMORY.md + topic files with turn-end extraction and /dream consolidation; save with # or /remember",
			},
		],
	},
});

// Claude Code memory-directory interop for the claudemd backend: read
// CC's per-project memory dir and `<project>/.claude/memory`, and (when a CC
// project dir is active) write /remember, extraction, and dream output into
// CC's directory so both tools share one copy. `auto` adopts CC when its
// config dir exists; `off` keeps omp's own dir; `on` always routes writes to
// the CC project dir. The omp dir is never deleted while CC sharing is on,
// and `clear` never touches CC directories.
export const cfgMemoryClaudeShared = register({
	id: "memory.claudeShared",
	type: "enum",
	values: ["off", "auto", "on"] as const,
	default: "auto",
	env: {
		name: "OMP_MEMORY_CLAUDE_SHARED",
		parse: raw => {
			const value = raw.trim().toLowerCase();
			return value === "off" || value === "auto" || value === "on" ? value : undefined;
		},
	},
	protocolDefault: ["rpc", "acp"],
	ui: {
		tab: "memory",
		group: "General",
		label: "Claude Memory Sharing",
		description: "Share memory directories with Claude Code (claudemd backend)",
		options: [
			{
				value: "off",
				label: "Off",
				description: "Only omp's own memory directory is used",
			},
			{
				value: "auto",
				label: "Auto",
				description: "Read and write Claude Code's project memory dir when Claude Code is installed here",
			},
			{
				value: "on",
				label: "On",
				description: "Always route writes to Claude Code's per-project memory directory",
			},
		],
	},
});
