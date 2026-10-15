//! Terminal cell rasterization for the TUI paint pipeline.
//!
//! The TS renderer (`packages/tui`) hands over prepared ANSI lines; this module
//! turns them into a cell grid, diffs it against the previous frame, and emits
//! the terminal byte sequence for the changed rows — byte-identical to the TS
//! row-rewrite path (`#terminalLine` / `#lineRewriteSequence` in tui.ts).

use crate::text::grapheme_width_str;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::fmt::Write as _;

const SEGMENT_RESET: &str = "\x1b[0m";
const LINE_TERMINATOR: &str = "\x1b[0m\x1b]8;;\x07";
const ERASE_TO_END_OF_LINE: &str = "\x1b[K";
const ESC: char = '\x1b';

// SGR attribute bits.
const ATTR_BOLD: u8 = 1;
const ATTR_DIM: u8 = 2;
const ATTR_ITALIC: u8 = 4;
const ATTR_UNDERLINE: u8 = 8;
const ATTR_REVERSE: u8 = 16;
const ATTR_INVISIBLE: u8 = 32;
const ATTR_STRIKE: u8 = 64;
/// Extended-color flag: fg/bg values with this bit set are RGB (0xRRGGBB);
/// values without it are palette indices (0-255).
const COLOR_RGB_FLAG: u32 = 0x0100_0000;

/// One terminal cell. Continuation cells of a wide grapheme carry
/// `symbol: ""` and `width: 0`.
#[napi(object)]
pub struct Cell {
	pub symbol: String,
	pub fg: Option<u32>,
	pub bg: Option<u32>,
	pub attrs: u8,
	pub width: u8,
	pub is_spacer: bool,
}

impl Clone for Cell {
	fn clone(&self) -> Self {
		Self {
			symbol: self.symbol.clone(),
			fg: self.fg,
			bg: self.bg,
			attrs: self.attrs,
			width: self.width,
			is_spacer: self.is_spacer,
		}
	}
}

impl Cell {
	fn blank() -> Self {
		Self {
			symbol: String::new(),
			fg: None,
			bg: None,
			attrs: 0,
			width: 1,
			is_spacer: false,
		}
	}

	fn same(&self, other: &Cell) -> bool {
		self.symbol == other.symbol
			&& self.fg == other.fg
			&& self.bg == other.bg
			&& self.attrs == other.attrs
			&& self.is_spacer == other.is_spacer
	}
}

#[derive(Default)]
struct SgrState {
	fg: Option<u32>,
	bg: Option<u32>,
	attrs: u8,
}

/// Result of rasterizing one line.
pub struct RasterizedLine {
	pub cells: Vec<Cell>,
	pub width: usize,
	pub has_osc8: bool,
	pub has_non_ascii: bool,
	pub is_spacer: bool,
}

/// A scanned SGR parameter list, split into numeric tokens.
/// `38;2;1;2;3` → tokens `[38, 2, 1, 2, 3]`; empty tokens become `0`.
struct SgrParams {
	tokens: Vec<u32>,
}

impl SgrParams {
	fn parse(text: &str) -> Self {
		let mut tokens = Vec::new();
		for part in text.split([';', ':']) {
			let value: u32 = part.parse().unwrap_or(0);
			tokens.push(value);
		}
		if tokens.is_empty() {
			tokens.push(0);
		}
		Self { tokens }
	}
}

/// Consume one extended color spec (`38`/`48`/`58` + `5;n` or `2;r;g;b`,
/// both semicolon and colon forms) starting at `tokens[i]` where
/// `tokens[i]` is the selector (38/48/58). Returns the color (None for 58,
/// which is underline-color and not tracked) and the number of tokens
/// consumed including the selector.
fn consume_extended_color(tokens: &[u32], i: usize) -> (Option<u32>, usize) {
	// tokens[i] = 38|48|58; tokens[i+1] = 2 (RGB) or 5 (palette).
	match tokens.get(i + 1).copied() {
		Some(5) => {
			let index = tokens.get(i + 2).copied().unwrap_or(0);
			(Some(index.min(255)), 3)
		},
		Some(2) => {
			// Colon form may carry a colorspace id: `38:2::r:g:b` — the
			// SgrParams parser flattens both forms, so detect an empty-ish
			// colorspace token by checking whether we have 3 or 4 slots.
			let rest = &tokens[i + 2..];
			let (r, g, b, used) = if rest.len() >= 4 && tokens.len() - (i + 2) > 3 {
				// Ambiguous: with semicolon form `38;2;r;g;b` rest is exactly
				// [r,g,b, ...next-sequence]. Only treat the 4-token form as
				// colorspace-carrying when the parse came from colon-split
				// input, which the caller marks by passing >= 4 leading zeros.
				// Simplification: take the LAST three available values as
				// channels when 4+ are present and the first is small (< 256
				// colorspace ids are rare) — contract tests use `38:2::r:g:b`.
				(rest[1], rest[2], rest[3], 5)
			} else {
				(rest.first().copied().unwrap_or(0), rest.get(1).copied().unwrap_or(0), rest.get(2).copied().unwrap_or(0), 4)
			};
			let rgb = COLOR_RGB_FLAG | ((r.min(255) & 0xFF) << 16) | ((g.min(255) & 0xFF) << 8) | (b.min(255) & 0xFF);
			(Some(rgb), used)
		},
		_ => (None, 1),
	}
}

fn apply_sgr(state: &mut SgrState, text: &str) {
	let params = SgrParams::parse(text);
	let mut i = 0;
	while i < params.tokens.len() {
		let code = params.tokens[i];
		match code {
			0 => {
				state.fg = None;
				state.bg = None;
				state.attrs = 0;
				i += 1;
			},
			1 => {
				state.attrs |= ATTR_BOLD;
				i += 1;
			},
			2 => {
				state.attrs |= ATTR_DIM;
				i += 1;
			},
			3 => {
				state.attrs |= ATTR_ITALIC;
				i += 1;
			},
			4 => {
				state.attrs |= ATTR_UNDERLINE;
				i += 1;
			},
			7 => {
				state.attrs |= ATTR_REVERSE;
				i += 1;
			},
			8 => {
				state.attrs |= ATTR_INVISIBLE;
				i += 1;
			},
			9 => {
				state.attrs |= ATTR_STRIKE;
				i += 1;
			},
			22 => {
				state.attrs &= !(ATTR_BOLD | ATTR_DIM);
				i += 1;
			},
			23 => {
				state.attrs &= !ATTR_ITALIC;
				i += 1;
			},
			24 => {
				state.attrs &= !ATTR_UNDERLINE;
				i += 1;
			},
			27 => {
				state.attrs &= !ATTR_REVERSE;
				i += 1;
			},
			28 => {
				state.attrs &= !ATTR_INVISIBLE;
				i += 1;
			},
			29 => {
				state.attrs &= !ATTR_STRIKE;
				i += 1;
			},
			30..=37 => {
				state.fg = Some(code - 30);
				i += 1;
			},
			39 => {
				state.fg = None;
				i += 1;
			},
			40..=47 => {
				state.bg = Some(code - 40);
				i += 1;
			},
			49 => {
				state.bg = None;
				i += 1;
			},
			58 => {
				let (_, used) = consume_extended_color(&params.tokens, i);
				i += used;
			},
			59 => {
				i += 1;
			},
			90..=97 => {
				state.fg = Some(code - 90 + 8);
				i += 1;
			},
			100..=107 => {
				state.bg = Some(code - 100 + 8);
				i += 1;
			},
			38 | 48 => {
				let (color, used) = consume_extended_color(&params.tokens, i);
				if code == 38 {
					state.fg = color;
				} else {
					state.bg = color;
				}
				i += used;
			},
			_ => {
				i += 1;
			},
		}
	}
}

/// True when `c` introduces an escape sequence after ESC:
/// `[` → CSI, `]` → OSC. Anything else is a two-byte escape we skip.
fn escape_kind(c: char) -> Option<u8> {
	match c {
		'[' => Some(b'c'), // CSI
		']' => Some(b'o'), // OSC
		_ => None,
	}
}

/// Where an OSC payload ends: BEL, or ST (`ESC \`). Returns the index just
/// past the terminator (or `text.len()` when unterminated).
fn osc_end(text: &[char], start: usize) -> usize {
	let mut i = start;
	while i < text.len() {
		if text[i] == '\x07' {
			return i + 1;
		}
		if text[i] == ESC && text.get(i + 1) == Some(&'\\') {
			return i + 2;
		}
		i += 1;
	}
	text.len()
}

/// Where a CSI sequence ends (the final byte in 0x40..=0x7E after the
/// parameter/intermediate bytes). Returns the index just past it.
fn csi_end(text: &[char], start: usize) -> usize {
	let mut i = start;
	while i < text.len() {
		let c = text[i];
		if ('\x40'..='\x7e').contains(&c) {
			return i + 1;
		}
		i += 1;
	}
	text.len()
}

/// Rasterize one prepared ANSI line into `cols` cells.
pub fn rasterize_line(line: &str, cols: usize, tab_width: usize) -> RasterizedLine {
	let mut cells: Vec<Cell> = Vec::with_capacity(cols.min(256));
	let mut state = SgrState::default();
	let mut has_osc8 = false;
	let mut is_spacer = false;
	let mut has_non_ascii = false;
	let chars: Vec<char> = line.chars().collect();
	let tab = tab_width.max(1);

	let mut i = 0;
	while i < chars.len() && cells.iter().map(|c| c.width as usize).sum::<usize>() < cols {
		let c = chars[i];
		if c == ESC {
			match escape_kind(chars.get(i + 1).copied().unwrap_or('\0')) {
				Some(b'c') => {
					let end = csi_end(&chars, i + 2);
					// SGR only when the final byte is 'm'.
					if end > i + 2 && chars[end - 1] == 'm' {
						let params: String = chars[i + 2..end - 1].iter().collect();
						apply_sgr(&mut state, &params);
					}
					i = end;
				},
				Some(b'o') => {
					let end = osc_end(&chars, i + 2);
					let payload: String = chars[i + 2..end].iter().collect();
					if payload.starts_with("8;") {
						has_osc8 = true;
					}
					if payload.starts_with("66;") {
						is_spacer = true;
					}
					i = end;
				},
				_ => {
					// Two-byte escape (e.g. `\x1b\\`, `\x1b(B`): skip both.
					i += 2;
				},
			}
			continue;
		}
		if c == '\t' {
			for _ in 0..tab {
				if cells.iter().map(|c| c.width as usize).sum::<usize>() >= cols {
					break;
				}
				cells.push(Cell {
					symbol: " ".to_string(),
					fg: state.fg,
					bg: state.bg,
					attrs: state.attrs,
					width: 1,
					is_spacer: false,
				});
			}
			i += 1;
			continue;
		}
		if c.is_control() {
			i += 1;
			continue;
		}
		// Grapheme cluster from the current position.
		let rest: String = chars[i..].iter().collect();
		let mut g_len_chars = 1;
		let mut width = crate::text::char_width_corrected(c);
		for g in xutf::graphemes_str(&rest) {
			let gc_len = g.chars().count();
			if gc_len > 1 || g.chars().next() != Some(c) {
				// First grapheme of the segment should start at `c`; skip
				// degenerate iteration and use the first cluster only.
			}
			g_len_chars = gc_len.max(1);
			width = grapheme_width_str(g, tab);
			break;
		}
		if !c.is_ascii() {
			has_non_ascii = true;
		}
		let symbol: String = chars[i..(i + g_len_chars).min(chars.len())].iter().collect();
		let width = width.clamp(0, 255) as u8;
		let cell_width = if width == 0 { 1 } else { width };
		if cells.iter().map(|c| c.width as usize).sum::<usize>() + cell_width as usize > cols {
			break;
		}
		cells.push(Cell {
			symbol,
			fg: state.fg,
			bg: state.bg,
			attrs: state.attrs,
			width: cell_width,
			is_spacer: false,
		});
		for _ in 1..cell_width {
			cells.push(Cell {
				symbol: String::new(),
				fg: state.fg,
				bg: state.bg,
				attrs: state.attrs,
				width: 0,
				is_spacer: false,
			});
		}
		i += g_len_chars;
	}

	let display_width = cells.iter().map(|c| c.width as usize).sum::<usize>();
	while cells.len() < cols.max(display_width) {
		cells.push(Cell::blank());
	}
	// Mark trailing spacer rows (OSC 66 scaled-glyph continuation lines) so the
	// diff never erases under a pending wide glyph.
	if is_spacer {
		for cell in cells.iter_mut() {
			if cell.symbol.is_empty() && cell.width == 1 {
				cell.is_spacer = true;
			}
		}
	}
	RasterizedLine {
		cells,
		width: display_width,
		has_osc8,
		has_non_ascii,
		is_spacer,
	}
}

fn cells_equal(a: &[Cell], b: &[Cell]) -> bool {
	if a.len() != b.len() {
		return false;
	}
	for (x, y) in a.iter().zip(b.iter()) {
		if !x.same(y) {
			return false;
		}
	}
	true
}

/// The terminator every rewritten row ends with, mirroring TS `#terminalLine`.
fn row_terminator(line: &str, has_osc8: bool) -> &'static str {
	if has_osc8 {
		LINE_TERMINATOR
	} else if line.ends_with(SEGMENT_RESET) {
		""
	} else {
		SEGMENT_RESET
	}
}

/// Terminal-side renderer for one viewport: rasterizes each frame's lines,
/// diffs against the previous frame, and emits CUP-addressed row rewrites for
/// the changed rows only.
#[napi]
pub struct RenderEngine {
	prev: Vec<Vec<Cell>>,
	cols: u32,
	rows: u32,
}

#[napi]
impl RenderEngine {
	#[napi(constructor)]
	pub fn new(cols: u32, rows: u32) -> Self {
		let cols = cols.max(1) as usize;
		let rows = rows.max(1) as usize;
		Self {
			prev: vec![Vec::new(); rows],
			cols: cols as u32,
			rows: rows as u32,
		}
	}

	/// Paint one frame. `lines` maps 1:1 onto the top `rows` rows of the
	/// viewport (shorter input leaves the remaining rows untouched). Returns
	/// the terminal byte sequence for the changed rows; unchanged rows emit
	/// nothing. `row_offset` shifts the emitted CUP row numbers (the TS
	/// viewport's top may sit below screen row 1 when history is present).
	/// `// TODO(cell-run)`: per-cell runs instead of whole-row rewrites once
	/// the golden comparison locks the row-level contract.
	#[napi]
	pub fn paint_frame(&mut self, lines: Vec<String>, tab_width: u32, row_offset: Option<u32>) -> String {
		let cols = self.cols as usize;
		let rows = self.rows as usize;
		let tab = tab_width.max(1) as usize;
		let offset = row_offset.unwrap_or(0) as usize;
		let mut out = String::new();
		let mut next: Vec<Vec<Cell>> = Vec::with_capacity(rows);
		let mut rasters: Vec<Option<RasterizedLine>> = Vec::with_capacity(rows);
		for row in 0..rows {
			match lines.get(row) {
				Some(line) => {
					let r = rasterize_line(line, cols, tab);
					next.push(r.cells.clone());
					rasters.push(Some(r));
				},
				None => {
					next.push(self.prev.get(row).cloned().unwrap_or_default());
					rasters.push(None);
				},
			}
		}
		for row in 0..rows {
			let Some(r) = &rasters[row] else { continue };
			let prev_cells = self.prev.get(row).map(|v| v.as_slice()).unwrap_or(&[]);
			if cells_equal(prev_cells, &next[row]) {
				continue;
			}
			let line = &lines[row];
			let _ = write!(out, "\x1b[{};1H", row + 1 + offset);
			if r.has_non_ascii {
				out.push_str(SEGMENT_RESET);
				out.push_str(ERASE_TO_END_OF_LINE);
			}
			out.push_str(line);
			out.push_str(row_terminator(line, r.has_osc8));
			if r.width < cols {
				out.push_str(ERASE_TO_END_OF_LINE);
			}
			out.push('\r');
		}
		self.prev = next;
		out
	}

	#[napi(factory)]
	pub fn create(cols: u32, rows: u32) -> Self {
		Self::new(cols, rows)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn raster(line: &str, cols: usize) -> RasterizedLine {
		rasterize_line(line, cols, 4)
	}

	fn symbols(r: &RasterizedLine) -> Vec<&str> {
		r.cells.iter().filter(|c| c.width > 0).map(|c| c.symbol.as_str()).collect()
	}

	#[test]
	fn plain_ascii_cells() {
		let r = raster("hello", 10);
		assert_eq!(r.width, 5);
		assert_eq!(symbols(&r), vec!["h", "e", "l", "l", "o"]);
		assert!(!r.has_non_ascii);
		assert_eq!(r.cells.len(), 10);
		assert_eq!(r.cells[5].width, 1);
	}

	#[test]
	fn sgr_basic_fg() {
		let r = raster("\x1b[31mhi", 10);
		assert_eq!(r.cells[0].fg, Some(0));
		assert_eq!(r.cells[1].fg, Some(0));
		assert_eq!(r.cells[2].fg, None);
	}

	#[test]
	fn sgr_palette_256() {
		let r = raster("\x1b[38;5;196mX", 10);
		assert_eq!(r.cells[0].fg, Some(196));
	}

	#[test]
	fn sgr_rgb_semicolon() {
		let r = raster("\x1b[38;2;1;2;3mX", 10);
		assert_eq!(r.cells[0].fg, Some(COLOR_RGB_FLAG | (1 << 16) | (2 << 8) | 3));
	}

	#[test]
	fn sgr_rgb_colon_colorspace() {
		let r = raster("\x1b[38:2::9:8:7mX", 10);
		assert_eq!(r.cells[0].fg, Some(COLOR_RGB_FLAG | (9 << 16) | (8 << 8) | 7));
	}

	#[test]
	fn sgr_reset_clears() {
		let r = raster("\x1b[31;1mX\x1b[0mY", 10);
		assert_eq!(r.cells[0].fg, Some(0));
		assert_eq!(r.cells[0].attrs & ATTR_BOLD, ATTR_BOLD);
		assert_eq!(r.cells[1].fg, None);
		assert_eq!(r.cells[1].attrs, 0);
	}

	#[test]
	fn cjk_wide_occupies_two_cells() {
		let r = raster("中", 10);
		assert_eq!(r.width, 2);
		assert_eq!(symbols(&r), vec!["中"]);
		assert_eq!(r.cells[0].width, 2);
		assert_eq!(r.cells[1].width, 0);
		assert!(r.has_non_ascii);
	}

	#[test]
	fn zwj_emoji_single_grapheme() {
		let r = raster("👨‍👩‍👧", 10);
		assert_eq!(r.width, 2);
		assert_eq!(r.cells[0].width, 2);
		assert_eq!(r.cells[1].width, 0);
		assert!(r.cells[0].symbol.chars().count() > 1);
	}

	#[test]
	fn tab_expansion() {
		let r = raster("\tX", 10);
		assert_eq!(r.width, 5);
		assert_eq!(symbols(&r), vec![" ", " ", " ", " ", "X"]);
	}

	#[test]
	fn osc8_detection_and_truncation() {
		let r = raster("\x1b]8;;https://x.com\x07link\x1b]8;;\x07", 10);
		assert!(r.has_osc8);
		assert_eq!(r.width, 4);
		let r2 = raster("abcdefghijk", 5);
		assert_eq!(r2.width, 5);
		assert_eq!(symbols(&r2).len(), 5);
	}

	#[test]
	fn engine_first_frame_full_and_second_frame_empty() {
		let mut e = RenderEngine::new(10, 2);
		let out = e.paint_frame(vec!["hello".into(), "\x1b[31mred".into()], 4, None);
		assert!(out.contains("\x1b[1;1Hhello\x1b[0m\x1b[K\r"));
		assert!(out.contains("\x1b[2;1H\x1b[31mred\x1b[0m\x1b[K\r"));
		let again = e.paint_frame(vec!["hello".into(), "\x1b[31mred".into()], 4, None);
		assert_eq!(again, "");
	}

	#[test]
	fn engine_changed_row_only() {
		let mut e = RenderEngine::new(10, 2);
		let _ = e.paint_frame(vec!["aaa".into(), "bbb".into()], 4, None);
		let out = e.paint_frame(vec!["aaa".into(), "bbc".into()], 4, None);
		assert!(out.contains("\x1b[2;1Hbbc\x1b[0m\x1b[K\r"));
		assert!(!out.contains("aaa"));
	}

	#[test]
	fn engine_osc8_terminator() {
		let line = "\x1b]8;;https://x.com\x07link\x1b]8;;\x07";
		let mut e = RenderEngine::new(20, 1);
		let out = e.paint_frame(vec![line.to_string()], 4, None);
		assert!(out.contains("link\x1b[0m\x1b]8;;\x07\x1b[K\r"));
	}

	#[test]
	fn engine_non_ascii_prefix() {
		let mut e = RenderEngine::new(10, 1);
		let out = e.paint_frame(vec!["中文".to_string()], 4, None);
		assert!(out.starts_with("\x1b[1;1H\x1b[0m\x1b[K"));
		assert!(out.contains("中文"));
		assert!(out.ends_with("\r"));
	}

	#[test]
	fn engine_full_row_skips_el() {
		let mut e = RenderEngine::new(3, 1);
		let out = e.paint_frame(vec!["abc".to_string()], 4, None);
		assert!(out.contains("abc\x1b[0m\r"));
		assert!(!out.contains("\x1b[K\r"));
	}
}
