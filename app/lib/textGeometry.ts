// Text measurement + multi-line caret geometry for the canvas editor.
//
// These are pure, UI-independent helpers extracted from MindmapEditor: the
// canvas redraw needs each node's width and per-character cursor offsets, and
// the caret/keyboard logic needs to map between absolute string offsets and
// (line, column) positions. Measuring via Konva.Text objects is very expensive
// (one object per character, per node, per redraw), so we measure with a single
// shared 2D context and cache offsets per text string — only the actively
// edited node's text changes per keystroke, so every other node is an O(1)
// cache hit.

import {
  NODE_FONT,
  DEFAULT_FONT_SIZE,
  NODE_MAX_CONTENT_WIDTH,
  nodeFontString,
  lineHeightFor,
  wrapNodeText,
} from "./measureText";

const NODE_FONT_ITALIC = `italic ${NODE_FONT}`;
let _measureCtx: CanvasRenderingContext2D | null | undefined;
const _offsetCache = new Map<string, number[]>();
let _emptyWidth = -1;

function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (_measureCtx === undefined) {
    // No DOM (Node test runner / SSR worker): fall back to a cheap estimate.
    _measureCtx =
      typeof document === "undefined"
        ? null
        : document.createElement("canvas").getContext("2d");
    if (_measureCtx) _measureCtx.font = NODE_FONT;
  }
  return _measureCtx;
}

/**
 * Cumulative prefix widths for `text`: [0, w(c0), w(c0c1), …, fullWidth].
 * Measured with `font` (defaults to the 14px node font) so the caret offsets
 * line up with a node's own font size / weight.
 */
export function measureOffsets(text: string, font: string = NODE_FONT): number[] {
  const key = font === NODE_FONT ? text : `${font}|${text}`;
  const cached = _offsetCache.get(key);
  if (cached) return cached;
  const ctx = getMeasureCtx();
  const offsets: number[] = [0];
  if (ctx) {
    if (font !== NODE_FONT) ctx.font = font;
    for (let i = 0; i < text.length; i++) {
      offsets.push(ctx.measureText(text.slice(0, i + 1)).width);
    }
    if (font !== NODE_FONT) ctx.font = NODE_FONT;
  } else {
    for (let i = 0; i < text.length; i++) offsets.push((i + 1) * 8);
  }
  if (_offsetCache.size > 4000) _offsetCache.clear();
  _offsetCache.set(key, offsets);
  return offsets;
}

/** Width of the italic "empty" placeholder (measured once). */
export function measureEmptyWidth(): number {
  if (_emptyWidth >= 0) return _emptyWidth;
  const ctx = getMeasureCtx();
  if (ctx) {
    ctx.font = NODE_FONT_ITALIC;
    _emptyWidth = ctx.measureText("empty").width;
    ctx.font = NODE_FONT;
  } else {
    _emptyWidth = 40;
  }
  return _emptyWidth;
}

export interface LineData {
  /** VISUAL lines: hard `\n` breaks plus soft wraps at the width cap. */
  lines: string[];
  /** Per-line cumulative char x-offsets (from measureOffsets). */
  lineOffsets: number[][];
  /** Absolute start index of each line in the full string. */
  lineStarts: number[];
  /** Line box height in px for this node's font size. */
  lineHeight: number;
}

/**
 * Split node text into its VISUAL lines and pre-measure each line's caret
 * offsets, using the node's own `fontSize` / `bold` so offsets and line height
 * match the rendered text (including the actively edited node).
 *
 * Line breaking is delegated to {@link wrapNodeText}, the same function that
 * sizes the box in measureNodeBox — the caret can therefore never land on a
 * line the layout doesn't know about. `maxWidth` is the content-width cap the
 * caller draws the text at (a link node subtracts its favicon column, say);
 * pass `Infinity` to break on hard newlines only.
 */
export function buildLineData(
  text: string,
  fontSize: number = DEFAULT_FONT_SIZE,
  bold: boolean = false,
  maxWidth: number = NODE_MAX_CONTENT_WIDTH
): LineData {
  const font = nodeFontString(fontSize, bold);
  const { lines, lineStarts } = wrapNodeText(text, { fontSize, bold, maxWidth });
  const lineOffsets = lines.map((l) => measureOffsets(l, font));
  return { lines, lineOffsets, lineStarts, lineHeight: lineHeightFor(fontSize) };
}

/** Absolute string offset → { line, column-within-line }. */
export function posToLineCol(
  data: LineData,
  pos: number
): { line: number; col: number } {
  const { lines, lineStarts } = data;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (pos >= lineStarts[i]) {
      return { line: i, col: Math.min(pos - lineStarts[i], lines[i].length) };
    }
  }
  return { line: 0, col: 0 };
}

/** { line, column } → absolute string offset (clamped to the line's length). */
export function lineColToPos(data: LineData, line: number, col: number): number {
  const l = Math.max(0, Math.min(line, data.lines.length - 1));
  return data.lineStarts[l] + Math.min(col, data.lines[l].length);
}

/** Widest line's measured width (px). */
export function lineDataWidth(data: LineData): number {
  let w = 0;
  for (const offs of data.lineOffsets) w = Math.max(w, offs[offs.length - 1] || 0);
  return w;
}

/** Find the caret column nearest `relX` within a line's offsets. */
export function nearestCol(offsets: number[] | undefined, relX: number): number {
  if (!offsets) return 0;
  let col = 0;
  let best = Math.abs(relX);
  for (let i = 1; i < offsets.length; i++) {
    const d = Math.abs(relX - offsets[i]);
    if (d < best) {
      best = d;
      col = i;
    }
  }
  return col;
}

/**
 * Vertical caret move within a node; returns new pos or null if no such line.
 *
 * Deliberately breaks on HARD newlines only (`Infinity` cap): this is shared by
 * both layouts through the keymap's edit-up / edit-down, and a soft wrap sits
 * at a different place on the canvas (the node's width cap) than in the outline
 * (the row's DOM width). Hard newlines are the one line structure both agree
 * on, so ↑/↓ behave identically in either view — and the keyboard-escape
 * invariant keeps its exact, layout-independent step count.
 */
export function verticalMove(
  text: string,
  pos: number,
  dir: -1 | 1
): number | null {
  const data = buildLineData(text, DEFAULT_FONT_SIZE, false, Infinity);
  const { line, col } = posToLineCol(data, pos);
  const target = line + dir;
  if (target < 0 || target >= data.lines.length) return null;
  return lineColToPos(data, target, col);
}
