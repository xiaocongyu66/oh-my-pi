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

/// SGR parameter stream as semicolon-split groups with colon sub-parameters.
///
/// `38;2;r;g;b` → groups `[[38],[2],[r],[g],[b]]`; `38:2::r:g:b` →
/// `[[38],[2],[0],[r],[g],[b]]` flattened: colon sub-parameters stay inside
/// one group so an SGR like `38:2::9:8:7` is parsed as one extended color
/// with a colorspace id, while `38;2;9;8;7` (the semicolon form, possibly a
/// fragment of an SGR run that TS `coalesceAdjacentSgr` merged) consumes
/// exactly its own parameter count and never swallows a following sequence's
/// parameters.
struct SgrStream {
	groups: Vec<Vec<u32>>,
}

impl SgrStream {
	fn parse(text: &str) -> Self {
		let groups = text
			.split(';')
			.map(|group| {
				let values: Vec<u32> = group.split(':').map(|p| p.parse().unwrap_or(0)).collect();
				if values.is_empty() {
					vec![0]
				} else {
					values
				}
			})
			.collect();
		Self { groups }
	}
}

/// Resolve one colon-form extended color group (`group[0]` is 38/48/58 and
/// the group carries sub-parameters). `38:5:n` → palette; `38:2:r:g:b` (no
/// colorspace) and `38:2:cs:r:g:b` / `38:2::r:g:b` (colorspace-id slot empty
/// or explicit) → RGB. 58 (underline color) consumes the group without
/// storing.
fn colon_extended_color(group: &[u32]) -> Option<u32> {
	match group.get(1) {
		Some(5) => Some(group.get(2).copied().unwrap_or(0).min(255)),
		Some(2) => {
			let (r, g, b) = if group.len() >= 6 {
				(group[3], group[4], group[5])
			} else {
				(group.get(2).copied().unwrap_or(0), group.get(3).copied().unwrap_or(0), group.get(4).copied().unwrap_or(0))
			};
			Some(COLOR_RGB_FLAG | ((r & 0xFF) << 16) | ((g & 0xFF) << 8) | (b & 0xFF))
		},
		_ => None,
	}
}

fn apply_sgr(state: &mut SgrState, text: &str) {
	let stream = SgrStream::parse(text);
	let mut gi = 0;
	while gi < stream.groups.len() {
		let group = &stream.groups[gi];
		let code = group[0];
		match code {
			0 => {
				state.fg = None;
				state.bg = None;
				state.attrs = 0;
				gi += 1;
			},
			1 => {
				state.attrs |= ATTR_BOLD;
				gi += 1;
			},
			2 => {
				state.attrs |= ATTR_DIM;
				gi += 1;
			},
			3 => {
				state.attrs |= ATTR_ITALIC;
				gi += 1;
			},
			4 => {
				state.attrs |= ATTR_UNDERLINE;
				gi += 1;
			},
			7 => {
				state.attrs |= ATTR_REVERSE;
				gi += 1;
			},
			8 => {
				state.attrs |= ATTR_INVISIBLE;
				gi += 1;
			},
			9 => {
				state.attrs |= ATTR_STRIKE;
				gi += 1;
			},
			22 => {
				state.attrs &= !(ATTR_BOLD | ATTR_DIM);
				gi += 1;
			},
			23 => {
				state.attrs &= !ATTR_ITALIC;
				gi += 1;
			},
			24 => {
				state.attrs &= !ATTR_UNDERLINE;
				gi += 1;
			},
			27 => {
				state.attrs &= !ATTR_REVERSE;
				gi += 1;
			},
			28 => {
				state.attrs &= !ATTR_INVISIBLE;
				gi += 1;
			},
			29 => {
				state.attrs &= !ATTR_STRIKE;
				gi += 1;
			},
			30..=37 => {
				state.fg = Some(code - 30);
				gi += 1;
			},
			39 => {
				state.fg = None;
				gi += 1;
			},
			40..=47 => {
				state.bg = Some(code - 40);
				gi += 1;
			},
			49 => {
				state.bg = None;
				gi += 1;
			},
			90..=97 => {
				state.fg = Some(code - 90 + 8);
				gi += 1;
			},
			100..=107 => {
				state.bg = Some(code - 100 + 8);
				gi += 1;
			},
			38 | 48 | 58 => {
				// Colon sub-parameters keep the whole spec inside this group.
				if group.len() > 1 {
					let color = colon_extended_color(group);
					if code == 38 {
						state.fg = color;
					} else if code == 48 {
						state.bg = color;
					}
					gi += 1;
					continue;
				}
				// Semicolon form: `5;n` spans 3 groups, `2;r;g;b` spans 5.
				// An incomplete spec consumes only the selector group — TS's
				// `endsWithIncompleteExtendedColor` guard prevents merged runs
				// from ever producing cross-sequence absorption, so never
				// extend past the selector here either.
				let next = stream.groups.get(gi + 1).map(|g| g[0]);
				match next {
					Some(5) => {
						let color = Some(stream.groups.get(gi + 2).map(|g| g[0]).unwrap_or(0).min(255));
						if code == 38 {
							state.fg = color;
						} else if code == 48 {
							state.bg = color;
						}
						gi += 3;
					},
					Some(2) => {
						let get = |k: usize| stream.groups.get(k).map(|g| g[0]).unwrap_or(0).min(255) & 0xFF;
						let color = Some(COLOR_RGB_FLAG | (get(gi + 2) << 16) | (get(gi + 3) << 8) | get(gi + 4));
						if code == 38 {
							state.fg = color;
						} else if code == 48 {
							state.bg = color;
						}
						gi += 5;
					},
					_ => {
						gi += 1;
					},
				}
			},
			_ => {
				gi += 1;
			},
		}
	}
}

/// Rasterize one prepared ANSI line into `cols` cells.
///
/// Scanning runs to end of line even after the cell budget fills: the line
/// flags (`has_osc8` / `is_spacer` / `has_non_ascii`) drive the rewrite
/// contract and must reflect the whole line, not its visible prefix.
pub fn rasterize_line(line: &str, cols: usize, tab_width: usize) -> RasterizedLine {
	let mut cells: Vec<Cell> = Vec::with_capacity(cols.min(256));
	let mut state = SgrState::default();
	let mut has_osc8 = false;
	let mut is_spacer = false;
	let mut has_non_ascii = false;
	let mut full = false;
	let chars: Vec<char> = line.chars().collect();
	let tab = tab_width.max(1);

	let mut i = 0;
	while i < chars.len() {
		let c = chars[i];
		if !(0x20..=0x7e).contains(&c) && c != ESC {
			// C0 control, DEL, C1, any non-ASCII grapheme: the TS classifier
			// marks the line non-ASCII (`code < 0x20 || code > 0x7e`).
			has_non_ascii = true;
		}
		if c == ESC {
			match chars.get(i + 1) {
				Some('[') => {
					// Consume to the final byte (0x40..=0x7E) directly so the
					// state flags keep scanning past it.
					let mut j = i + 2;
					while j < chars.len() && !('\x40'..='\x7e').contains(&chars[j]) {
						j += 1;
					}
					if j < chars.len() {
						if chars[j] == 'm' {
							let params: String = chars[i + 2..j].iter().collect();
							apply_sgr(&mut state, &params);
						}
						i = j + 1;
					} else {
						// Dangling CSI without a final byte: off the exact-ASCII
						// fast path, mirroring the TS classifier's final check.
						has_non_ascii = true;
						i = chars.len();
					}
					continue;
				},
				Some(']') => {
					let mut j = i + 2;
					let mut closed = false;
					while j < chars.len() {
						if chars[j] == '\x07' {
							closed = true;
							break;
						}
						if chars[j] == ESC && chars.get(j + 1) == Some(&'\\') {
							j += 1;
							closed = true;
							break;
						}
						j += 1;
					}
					let payload: String = chars[i + 2..j.min(chars.len())].iter().collect();
					if payload.starts_with("8;") {
						has_osc8 = true;
					}
					if payload.starts_with("66;") {
						is_spacer = true;
						has_non_ascii = true;
					}
					if !closed {
						// Unterminated OSC: dangling control state, same as TS.
						has_non_ascii = true;
					}
					i = if closed { j + 1 } else { j };
					continue;
				},
				_ => {
					// Any other escape is non-ASCII per the TS classifier, and
					// intermediates (e.g. charset `\x1b(B`) extend past the
					// immediate next byte: ESC + intermediates + final.
					has_non_ascii = true;
					i += 2;
					while i < chars.len() && ('\x20'..='\x2f').contains(&chars[i - 1]) {
						i += 1;
					}
					continue;
				},
			}
		}
		if c == '\t' {
			has_non_ascii = true;
			if full {
				i += 1;
				continue;
			}
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
		let rest: String = chars[i..].iter().collect();
		let mut g_len_chars = 1;
		let mut width = crate::text::char_width_corrected(c);
		for g in xutf::graphemes_str(&rest) {
			g_len_chars = g.chars().count().max(1);
			width = grapheme_width_str(g, tab);
			break;
		}
		let symbol: String = chars[i..(i + g_len_chars).min(chars.len())].iter().collect();
		let width = width.clamp(0, 255) as u8;
		let cell_width = if width == 0 { 1 } else { width };
		let used = cells.iter().map(|c| c.width as usize).sum::<usize>();
		if used + cell_width as usize > cols {
			// Wide-grapheme overflow discards the whole line remainder (the TS
			// line fitter breaks on the first glyph that does not fit) rather
			// than pulling later chars into the freed space. Scanning itself
			// continues — end-of-line flags must see the rest of the line.
			full = true;
			i += g_len_chars;
			continue;
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
	while cells.len() < cols {
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
	/// Raw source lines of `prev`, so a same-cells-but-different-bytes row
	/// (e.g. a changed OSC 8 link target) still triggers a rewrite and never
	/// leaves a stale hyperlink behind.
	prev_lines: Vec<String>,
	prev_offset: usize,
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
			prev_lines: vec![String::new(); rows],
			prev_offset: 0,
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
			// A row rewrite must fire when the cells differ, when the source
			// bytes differ (same visible cells but a changed OSC 8 target, for
			// instance — links would otherwise go stale), or when the CUP row
			// offset moved (the previous frame's rows were addressed elsewhere,
			// so nothing on screen can be trusted to match this one).
			let line_same = match (lines.get(row), self.prev_lines.get(row)) {
				(Some(line), Some(prev_line)) => line == prev_line,
				(None, None) => true,
				_ => false,
			};
			if self.prev_offset == offset && line_same && cells_equal(prev_cells, &next[row]) {
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
			if !r.has_non_ascii && r.width < cols {
				out.push_str(ERASE_TO_END_OF_LINE);
			}
			out.push('\r');
		}
		self.prev = next;
		self.prev_lines = lines;
		self.prev_offset = offset;
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
		r.cells.iter().filter(|c| !c.symbol.is_empty()).map(|c| c.symbol.as_str()).collect()
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
		assert_eq!(r.cells[0].fg, Some(1));
		assert_eq!(r.cells[1].fg, Some(1));
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
	fn sgr_rgb_merged_run_keeps_following_params() {
		// A coalesced SGR run: RGB fg + bold + fg swap, semicolon-flattened.
		// The parser must consume exactly 5 groups per `38;2` spec.
		let r = raster("\x1b[38;2;255;0;0;1mA\x1b[38;2;0;0;255;22mB", 10);
		assert_eq!(r.cells[0].fg, Some(COLOR_RGB_FLAG | (255 << 16)));
		assert_eq!(r.cells[0].attrs & ATTR_BOLD, ATTR_BOLD);
		assert_eq!(r.cells[1].fg, Some(COLOR_RGB_FLAG | 255));
		assert_eq!(r.cells[1].attrs & (ATTR_BOLD | ATTR_DIM), 0);
	}

	#[test]
	fn sgr_rgb_colon_colorspace() {
		let r = raster("\x1b[38:2::9:8:7mX", 10);
		assert_eq!(r.cells[0].fg, Some(COLOR_RGB_FLAG | (9 << 16) | (8 << 8) | 7));
	}

	#[test]
	fn sgr_rgb_colon_no_colorspace() {
		let r = raster("\x1b[38:2:9:8:7mX", 10);
		assert_eq!(r.cells[0].fg, Some(COLOR_RGB_FLAG | (9 << 16) | (8 << 8) | 7));
	}

	#[test]
	fn sgr_reset_clears() {
		let r = raster("\x1b[31;1mX\x1b[0mY", 10);
		assert_eq!(r.cells[0].fg, Some(1));
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
	fn tab_expansion_marks_non_ascii() {
		let r = raster("\tX", 10);
		assert_eq!(r.width, 5);
		assert_eq!(symbols(&r), vec![" ", " ", " ", " ", "X"]);
		assert!(r.has_non_ascii);
	}

	#[test]
	fn osc8_detection_and_truncation() {
		let r = raster("\x1b]8;;https://x.com\x07link\x1b]8;;\x07", 10);
		assert!(r.has_osc8);
		assert_eq!(r.width, 4);
		// Truncation must not hide the closing OSC 8 sequence: the flag scan
		// runs to end of line, so LINE_TERMINATOR is still applied.
		let mut long = String::from("\x1b]8;;https://x.com\x07");
		long.push_str(&"x".repeat(16));
		long.push_str("\x1b]8;;\x07");
		let r2 = raster(&long, 5);
		assert!(r2.has_osc8);
		assert_eq!(r2.width, 5);
	}

	#[test]
	fn scattered_escape_marks_non_ascii() {
		let r = raster("a\x1b(Bb", 10);
		assert!(r.has_non_ascii);
		assert_eq!(symbols(&r), vec!["a", "b"]);
	}

	#[test]
	fn dangling_csi_marks_non_ascii() {
		let r = raster("ok\x1b[3", 10);
		assert!(r.has_non_ascii);
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
		// The row itself closes its hyperlink, then the row terminator repeats
		// the close (TS #terminalLine semantics), then the short-row EL.
		assert!(out.contains("link\x1b]8;;\x07\x1b[0m\x1b]8;;\x07\x1b[K\r"));
	}

	#[test]
	fn engine_non_ascii_prefix_no_trailing_el() {
		let mut e = RenderEngine::new(10, 1);
		let out = e.paint_frame(vec!["中文".to_string()], 4, None);
		assert!(out.starts_with("\x1b[1;1H\x1b[0m\x1b[K"));
		assert!(out.contains("中文"));
		assert!(out.ends_with("\r"));
		// The prefix EL already cleared the row; no trailing EL is appended.
		let tail = out.trim_end_matches('\r');
		assert!(!tail.ends_with(ERASE_TO_END_OF_LINE));
	}

	#[test]
	fn engine_full_row_skips_el() {
		let mut e = RenderEngine::new(3, 1);
		let out = e.paint_frame(vec!["abc".to_string()], 4, None);
		assert!(out.contains("abc\x1b[0m\r"));
		assert!(!out.contains("\x1b[K\r"));
	}

	#[test]
	fn engine_row_offset_shifts_cup_only() {
		let mut e = RenderEngine::new(10, 1);
		let out = e.paint_frame(vec!["hello".into()], 4, Some(7));
		assert!(out.starts_with("\x1b[8;1H"));
		// Same content at another offset still rewrites (CUP moved).
		let out2 = e.paint_frame(vec!["hello".into()], 4, Some(9));
		assert!(out2.starts_with("\x1b[10;1H"));
	}

	#[test]
	fn engine_shortened_row_uses_el_not_stale_cells() {
		let mut e = RenderEngine::new(5, 1);
		let _ = e.paint_frame(vec!["abcde".into()], 4, None);
		let out = e.paint_frame(vec!["ab".into()], 4, None);
		// Full rewrite of the shortened row: literal "ab" then the row EL.
		assert!(out.contains("\x1b[1;1Hab\x1b[0m\x1b[K\r"));
	}

	#[test]
	fn engine_empty_line_from_content() {
		let mut e = RenderEngine::new(5, 1);
		let _ = e.paint_frame(vec!["xy".into()], 4, None);
		let out = e.paint_frame(vec![String::new()], 4, None);
		assert_eq!(out, "\x1b[1;1H\x1b[0m\x1b[K\r");
	}

	#[test]
	fn engine_fewer_lines_keeps_prev_rows() {
		let mut e = RenderEngine::new(5, 2);
		let _ = e.paint_frame(vec!["one".into(), "two".into()], 4, None);
		let out = e.paint_frame(vec!["ONE".into()], 4, None);
		assert!(out.contains("ONE"));
		assert!(!out.contains("two"));
	}

	#[test]
	fn wide_grapheme_straddling_cols_is_dropped_whole() {
		// `中` needs 2 columns; with only 1 left after `a` it is discarded
		// whole rather than split across the boundary.
		let r = raster("a中", 2);
		assert_eq!(r.width, 1);
		assert_eq!(symbols(&r), vec!["a"]);
		// And with exactly 2 left it fits.
		let r2 = raster("a中", 3);
		assert_eq!(r2.width, 3);
	}
}
