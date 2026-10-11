/**
 * Terminal state collection for the debug menu.
 *
 * Surfaces the detected terminal, the established subprotocols the renderer
 * negotiated (graphics, desktop notifications, hyperlinks, true color), the
 * scrollback/erase strategy, and the live geometry — the details that decide
 * which escape sequences the renderer emits.
 */
import { t } from "@oh-my-pi/pi-i18n";
import {
	getCellDimensions,
	ImageProtocol,
	isOsc99Supported,
	NotifyProtocol,
	TERMINAL,
	TERMINAL_ID,
} from "../../terminal-capabilities";
import { classifyTerminalMultiplexer } from "../../terminal-multiplexer";

/** Live values the debug view reads off the running TUI, not the static capability table. */
export interface TerminalRuntimeState {
	columns: number;
	rows: number;
	/** Whether DEC 2026 synchronized-output wrappers are currently emitted. */
	synchronizedOutput: boolean;
}

/** Terminal capabilities, geometry, and detection environment. */
export interface TerminalStateInfo {
	detectedId: string;
	columns: number;
	rows: number;
	cellWidthPx: number;
	cellHeightPx: number;
	trueColor: boolean;
	imageProtocol: string;
	notifyProtocol: string;
	osc99Confirmed: boolean;
	hyperlinks: boolean;
	deccara: boolean;
	screenToScrollback: boolean;
	synchronizedOutput: boolean;
	multiplexer: string | null;
	env: { TERM?: string; TERM_PROGRAM?: string; TERM_PROGRAM_VERSION?: string; COLORTERM?: string };
}

const IMAGE_PROTOCOL_NAMES: Record<ImageProtocol, string> = {
	[ImageProtocol.Kitty]: "Kitty graphics",
	[ImageProtocol.Iterm2]: "iTerm2 inline images",
	[ImageProtocol.Sixel]: "Sixel",
};

const NOTIFY_PROTOCOL_NAMES: Record<NotifyProtocol, string> = {
	[NotifyProtocol.Bell]: "BEL (\\a)",
	[NotifyProtocol.Osc99]: "OSC 99 (kitty desktop notifications)",
	[NotifyProtocol.Osc9]: "OSC 9 (iTerm2/WezTerm)",
};

/** Snapshot the active terminal capabilities and the live runtime geometry. */
export function collectTerminalState(runtime: TerminalRuntimeState): TerminalStateInfo {
	const env = Bun.env;
	const cell = getCellDimensions();
	return {
		detectedId: TERMINAL_ID,
		columns: runtime.columns,
		rows: runtime.rows,
		cellWidthPx: cell.widthPx,
		cellHeightPx: cell.heightPx,
		trueColor: TERMINAL.trueColor,
		imageProtocol: TERMINAL.imageProtocol === null ? "none" : IMAGE_PROTOCOL_NAMES[TERMINAL.imageProtocol],
		notifyProtocol: NOTIFY_PROTOCOL_NAMES[TERMINAL.notifyProtocol],
		osc99Confirmed: isOsc99Supported(),
		hyperlinks: TERMINAL.hyperlinks,
		deccara: TERMINAL.deccara,
		screenToScrollback: TERMINAL.supportsScreenToScrollback,
		synchronizedOutput: runtime.synchronizedOutput,
		multiplexer: classifyTerminalMultiplexer(env),
		env: {
			TERM: env.TERM,
			TERM_PROGRAM: env.TERM_PROGRAM,
			TERM_PROGRAM_VERSION: env.TERM_PROGRAM_VERSION,
			COLORTERM: env.COLORTERM,
		},
	};
}

const yesNo = (value: boolean): string => (value ? t("yes") : t("no"));

/** Format terminal state for display in the debug menu. */
export function formatTerminalState(info: TerminalStateInfo): string {
	const lines = [
		t("Terminal State"),
		"━━━━━━━━━━━━━━",
		t("Detected:     {{id}}", { id: info.detectedId }),
		t("Geometry:     {{geometry}} cells · cell {{cell}}px", {
			geometry: `${info.columns}x${info.rows}`,
			cell: `${info.cellWidthPx}x${info.cellHeightPx}`,
		}),
		info.multiplexer ? t("Multiplexer:  {{mux}}", { mux: info.multiplexer }) : t("Multiplexer:  none"),
		"",
		t("Subprotocols"),
		`  ${t("Graphics:")}     ${info.imageProtocol}`,
		`  ${t("Notify:")}       ${info.notifyProtocol}${info.osc99Confirmed ? ` ${t("· confirmed via DA")}` : ""}`,
		`  ${t("Hyperlinks:")}   ${yesNo(info.hyperlinks)} (OSC 8)`,
		`  ${t("True color:")}   ${yesNo(info.trueColor)} (24-bit SGR)`,
		`  ${t("DECCARA:")}      ${yesNo(info.deccara)} (${t("rectangular-SGR background fills")})`,
		`  ${t("Sync output:")}  ${yesNo(info.synchronizedOutput)} (DEC 2026)`,
		"",
		t("Scrollback"),
		`  ${t("Screen->history clear:")} ${info.screenToScrollback ? "CSI 22 J" : t("CSI 2 J (redraw)")}`,
		"",
		t("Detection signals"),
		`  TERM:                 ${info.env.TERM ?? t("(unset)")}`,
		`  TERM_PROGRAM:         ${info.env.TERM_PROGRAM ?? t("(unset)")}`,
		`  TERM_PROGRAM_VERSION: ${info.env.TERM_PROGRAM_VERSION ?? t("(unset)")}`,
		`  COLORTERM:            ${info.env.COLORTERM ?? t("(unset)")}`,
	];
	return lines.join("\n");
}
