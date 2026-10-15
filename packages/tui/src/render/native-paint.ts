/**
 * Soft bridge to the Rust frame painter in `@oh-my-pi/pi-natives` (`RenderEngine`,
 * implemented by the parallel engine line in `crates/pi-natives`).
 *
 * The engine owns what {@link "../tui.ts"} `#renderProviderFrame` does today:
 * it takes the frame's prepared viewport rows (`TuiPaint.viewport` — one
 * normalized, width-truncated ANSI string per row) plus the effective tab width
 * (`DEFAULT_TAB_WIDTH`), and returns the terminal byte sequence for the frame —
 * cursor addressing plus one rewrite per visible row, each row write ending in
 * its line terminator (`SEGMENT_RESET`, or the OSC 8 line terminator
 * `\x1b[0m\x1b]8;;\x07` for hyperlink rows), the same per-row invariant
 * `#terminalLine` enforces on the TS path.
 *
 * Loading is deliberately soft: the addon on disk lags the checkout by design
 * (see `loader-state.js`'s stale-addon tolerance), and a build without the
 * engine must keep rendering through the TS path. Every failure mode — the
 * package failing to load, the export being absent, a constructor throw —
 * collapses to `undefined` here. Callers treat `undefined` as "paint in TS":
 * nothing may throw out of this module, and diagnosis is a single debug-level
 * log per process, never an error-level stall.
 *
 * Gated by the `omp.rustPaint` flag (see {@link isRustPaintEnabled}); the
 * mainline wiring (TUI → engine) lands separately and checks both the flag and
 * a successful load before routing a frame through the engine.
 */
import { createRequire } from "node:module";
import { $flag } from "@oh-my-pi/pi-utils/env";
import * as logger from "@oh-my-pi/pi-utils/logger";

/**
 * One native frame painter, scoped to a fixed geometry: constructed per
 * terminal size (`new RenderEngine(cols, rows)` on the Rust side) and re-painted
 * with successive frames so it can emit incremental byte sequences. Not an
 * instance you construct yourself — obtain one from {@link loadNativeRenderEngine}.
 */
export interface NativeRenderEngine {
	/**
	 * Paint one frame from prepared viewport rows and return the terminal bytes
	 * to write. `lines` are the frame's prepared rows (the `TuiPaint.viewport`
	 * shape: already normalized, width-fitted to the engine's `cols`, SGR-coalesced),
	 * `tabWidth` is the effective tab cell count (`DEFAULT_TAB_WIDTH`), and
	 * `rowOffset` shifts the emitted CUP row numbers (0 when the viewport starts
	 * at screen row 1). The first paint on a fresh engine is a full-viewport
	 * rewrite; a subsequent paint with overlapping rows may emit only the
	 * changed rows.
	 */
	paintFrame(lines: string[], tabWidth: number, rowOffset?: number): string;
}

/** Constructor shape of the addon's `RenderEngine` export. */
export interface NativeRenderEngineConstructor {
	new (cols: number, rows: number): NativeRenderEngine;
}

/** The subset of the addon namespace this bridge probes. */
type NativesWithRenderEngine = { RenderEngine?: NativeRenderEngineConstructor };

const requireNatives = createRequire(import.meta.url);

/** True once a debug line about the engine being unavailable has been logged this process. */
let unavailabilityLogged = false;

/**
 * Log the engine's absence exactly once per process, at debug level. A missing
 * engine is a normal configuration (addon not yet rebuilt, flag-off rollout),
 * so it must never surface as an error or repeat per frame.
 */
function logEngineUnavailable(reason: string, err?: unknown): void {
	if (unavailabilityLogged) return;
	unavailabilityLogged = true;
	logger.debug("native render engine unavailable; painting through the TS path", {
		reason,
		...(err === undefined ? {} : { err: String(err) }),
	});
}

/**
 * Whether the Rust paint path is switched on. Independent of whether the engine
 * actually loads: the flag expresses intent, {@link loadNativeRenderEngine}
 * expresses capability, and the mainline wiring requires both.
 */
export function isRustPaintEnabled(): boolean {
	return $flag("omp.rustPaint");
}

/**
 * Soft-load a native frame painter for a `cols`×`rows` viewport.
 *
 * Probes the addon's `RenderEngine` export and constructs one instance for the
 * given geometry. Returns `undefined` — never throws — when the package cannot
 * load, the export is missing (addon older than the engine, or not yet
 * generated), or construction fails. Callers fall back to the TS paint path on
 * `undefined`.
 */
export function loadNativeRenderEngine(cols: number, rows: number): NativeRenderEngine | undefined {
	let natives: NativesWithRenderEngine;
	try {
		// Synchronous load on purpose: the paint path wants a same-frame engine or
		// none at all, and Bun resolves an already-imported ESM package
		// synchronously through `require` (the TUI statically imports this package
		// elsewhere, so the module is cached — no double instantiation).
		natives = requireNatives("@oh-my-pi/pi-natives") as NativesWithRenderEngine;
	} catch (err) {
		logEngineUnavailable("@oh-my-pi/pi-natives failed to load", err);
		return undefined;
	}
	const ctor = natives?.RenderEngine;
	if (typeof ctor !== "function") {
		logEngineUnavailable("addon does not export RenderEngine");
		return undefined;
	}
	try {
		return new ctor(cols, rows);
	} catch (err) {
		logEngineUnavailable("RenderEngine constructor failed", err);
		return undefined;
	}
}
