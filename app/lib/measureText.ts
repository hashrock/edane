/**
 * Node text measurement using @chenglou/pretext.
 *
 * Computes each node's box width and height *without touching the DOM*
 * (no getBoundingClientRect / reflow). pretext needs a Canvas 2D context for
 * `measureText`, so on environments without one (Node test runner, SSR worker)
 * we fall back to a cheap character-count estimate. The fallback keeps the
 * pure-logic layout tests deterministic and the server render working.
 *
 * Lines break on explicit `\n` and, beyond {@link NODE_MAX_CONTENT_WIDTH}, on
 * soft wraps: a node grows horizontally only up to that cap, then vertically.
 */
import {
  prepareWithSegments,
  layoutWithLines,
  measureNaturalWidth,
} from "@chenglou/pretext";

/** Canvas font shorthand — must match the Konva.Text font used to render. */
export const NODE_FONT = "14px sans-serif";
/** Default node font size in px. */
export const DEFAULT_FONT_SIZE = 14;
/** CSS line-height in px for the 14px node font. */
export const LINE_HEIGHT = 18;
/**
 * Konva's lineHeight prop is a multiplier of fontSize, so Konva needs
 * LINE_HEIGHT / DEFAULT_FONT_SIZE to produce the same px line box that
 * measureNodeBox uses internally.
 */
export const KONVA_LINE_HEIGHT = LINE_HEIGHT / DEFAULT_FONT_SIZE;

/** Per-font-size line height in px, scaled from the 14px → 18px baseline. */
export function lineHeightFor(fontSize: number): number {
  return Math.round((fontSize * LINE_HEIGHT) / DEFAULT_FONT_SIZE);
}

/** Canvas/Konva font shorthand for a node's size + weight. */
export function nodeFontString(fontSize: number, bold: boolean): string {
  return `${bold ? "bold " : ""}${fontSize}px sans-serif`;
}

export interface MeasureOpts {
  /** Font size in px (default 14). */
  fontSize?: number;
  /** Bold weight (default false). */
  bold?: boolean;
  /**
   * Content width cap in px (default {@link NODE_MAX_CONTENT_WIDTH}); text
   * soft-wraps at it. Pass `Infinity` for a measurement that must stay on one
   * line per hard break (e.g. the markdown card's ellipsised title).
   */
  maxWidth?: number;
}
/** Vertical padding added around the text block to form the node box. */
const BOX_V_PAD = 14;
/** Minimum node box height (keeps single-line nodes at their original size). */
const MIN_BOX_HEIGHT = 32;

/** Horizontal padding between a node's box edge and its content (px). */
export const NODE_PADDING = 20;

/**
 * THE upper bound on a node's CONTENT width (px) — the one place the "nodes
 * must not grow sideways forever" rule is expressed. Everything a node can
 * hold is sized against it, so the widest possible node box is
 * `NODE_MAX_CONTENT_WIDTH + NODE_PADDING * 2`:
 *
 *  - text / link title / object-card title & field values → soft-wrap here
 *    (see {@link wrapNodeText}), growing downwards instead of sideways;
 *  - markdown card title → stays one line and is ellipsised at this width
 *    (the card is deliberately compact — the document opens in the panel);
 *  - image → scaled down to fit (aspect preserved), see lib/imageCache.
 *
 * 420px ≈ 60 latin / 30 CJK characters at the 14px node font, which keeps a
 * long paragraph inside a comfortable reading measure.
 */
export const NODE_MAX_CONTENT_WIDTH = 420;

/**
 * Visual box width for a measured text/content width: add horizontal padding,
 * then floor (roots a little wider). Keeps every node-box width derivation in
 * one place — the canvas draw and the drag-drop hit test must agree — so
 * neither ever re-implements per-kind sizing.
 */
export function nodeBoxWidth(measuredWidth: number, isRoot: boolean): number {
  return Math.max(measuredWidth + NODE_PADDING * 2, isRoot ? 100 : 80);
}

/** Visual box height for a measured content height (px), with the 32px floor. */
export function nodeBoxHeight(measuredHeight: number): number {
  return Math.max(MIN_BOX_HEIGHT, measuredHeight);
}

export interface NodeBox {
  /** Widest line's measured width (px); bounded by the caller's width cap. */
  width: number;
  /** Full box height including vertical padding (px). */
  height: number;
  /** Number of VISUAL lines — hard breaks plus soft wraps (>= 1). */
  lineCount: number;
}

export interface WrappedText {
  /** Visual lines: hard `\n` breaks plus soft wraps at the width cap. */
  lines: string[];
  /** Absolute start offset of each visual line in the source string. */
  lineStarts: number[];
  /** Widest visual line's measured width (px); never exceeds the cap. */
  width: number;
  /**
   * `lines` joined back with "\n" — the exact string to render. Built once at
   * wrap time so the per-redraw draw path is a field read, not a join.
   */
  visualText: string;
}

const _wrapCache = new Map<string, WrappedText>();
/** Derived box per wrap result, so a cache hit stays allocation-free. */
const _boxCache = new WeakMap<WrappedText, NodeBox>();

function canMeasure(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof document.createElement === "function"
  );
}

/** One visual line: its text, its start offset within the hard line, its width. */
interface Piece {
  text: string;
  start: number;
  width: number;
}

/**
 * Character-count estimate used when no Canvas 2D context is available (Node
 * test runner / SSR worker). Breaks at the last space that still fits, falling
 * back to a mid-word break so an unbroken run can't exceed the cap either.
 */
function estimatePieces(line: string, fontSize: number, maxWidth: number): Piece[] {
  const charW = fontSize * 0.6;
  const perLine = Math.max(1, Math.floor(maxWidth / charW));
  if (line.length <= perLine) {
    return [{ text: line, start: 0, width: line.length * charW }];
  }
  const pieces: Piece[] = [];
  let start = 0;
  while (start < line.length) {
    let end = Math.min(line.length, start + perLine);
    if (end < line.length) {
      const space = line.lastIndexOf(" ", end);
      // Only honour a space that leaves a non-empty line behind.
      if (space > start) end = space + 1;
    }
    const text = end < line.length ? trimLineEnd(line.slice(start, end)) : line.slice(start, end);
    pieces.push({ text, start, width: text.length * charW });
    start = end;
  }
  return pieces;
}

/**
 * Drop the whitespace a soft break consumed. Like CSS, a wrapped line "hangs"
 * its trailing spaces: they neither widen the line box nor get drawn, and the
 * caret offsets that land in them resolve to the end of the line (the gap
 * between two lineStarts, exactly as for a consumed "\n").
 */
function trimLineEnd(text: string): string {
  return text.replace(/[ \t]+$/, "");
}

function measureText(s: string, font: string): number {
  return measureNaturalWidth(
    prepareWithSegments(s, font, { whiteSpace: "pre-wrap" })
  );
}

/** Advance width of one space, memoised per font (see wrapOneLine). */
const _spaceWidths = new Map<string, number>();
function spaceWidth(font: string): number {
  let w = _spaceWidths.get(font);
  if (w === undefined) {
    w = measureText(" ", font);
    _spaceWidths.set(font, w);
  }
  return w;
}

/**
 * Where in `line` the visual line `text` starts, given the previous line ended
 * at `pos`. A break only ever eats whitespace, so the answer is `pos` or just
 * past a whitespace run — a bounded probe. (`indexOf` would also find it, but
 * scans the whole remaining string when pretext's text isn't a literal
 * substring — e.g. a CR that `pre-wrap` normalised away — turning a paste with
 * CRLF endings into an O(n²) walk.)
 */
function lineStartAt(line: string, text: string, pos: number): number {
  let start = pos;
  while (
    start < line.length &&
    !line.startsWith(text, start) &&
    /\s/.test(line[start])
  ) {
    start++;
  }
  return line.startsWith(text, start) ? start : pos;
}

/** Soft-wrap ONE hard line (no `\n` inside) to `maxWidth`. */
function wrapOneLine(
  line: string,
  font: string,
  fontSize: number,
  maxWidth: number
): Piece[] {
  if (!canMeasure()) return estimatePieces(line, fontSize, maxWidth);

  const prepared = prepareWithSegments(line, font, { whiteSpace: "pre-wrap" });
  const natural = measureNaturalWidth(prepared);
  // Fast path (and the only path for an empty line, which pretext lays out as
  // zero lines): nothing to break.
  if (natural <= maxWidth) return [{ text: line, start: 0, width: natural }];

  const { lines } = layoutWithLines(prepared, maxWidth, 1);
  const pieces: Piece[] = [];
  let pos = 0;
  lines.forEach((l, i) => {
    const start = lineStartAt(line, l.text, pos);
    pos = start + l.text.length;
    // pretext reports the PAINTED width, which still counts the space the
    // break ate — leaving it in would push the box a few px past the cap and
    // make it disagree with the caret's own measurement of the drawn line.
    // Latin prose breaks on a space almost every time, so subtracting the
    // (constant) space advance beats re-preparing the trimmed line; only the
    // rare tab falls back to a real measurement.
    const text = i === lines.length - 1 ? l.text : trimLineEnd(l.text);
    const dropped = l.text.slice(text.length);
    const width =
      dropped === ""
        ? l.width
        : dropped.includes("\t")
          ? measureText(text, font)
          : l.width - dropped.length * spaceWidth(font);
    pieces.push({ text, start, width });
  });
  return pieces;
}

/**
 * Split `text` into the visual lines a node actually renders: hard `\n` breaks
 * always split, and any line still wider than the cap soft-wraps.
 *
 * This is the single wrapping authority — {@link measureNodeBox} (layout) and
 * lib/textGeometry's `buildLineData` (caret geometry + canvas draw) both go
 * through it, so the box, the drawn text and the caret can never disagree
 * about where a line breaks. Cached: only the actively edited node's text
 * changes between renders, so every other node is an O(1) hit.
 */
export function wrapNodeText(text: string, opts?: MeasureOpts): WrappedText {
  const fontSize = opts?.fontSize ?? DEFAULT_FONT_SIZE;
  const bold = opts?.bold ?? false;
  const maxWidth = opts?.maxWidth ?? NODE_MAX_CONTENT_WIDTH;
  // Hard-break-only layout is cap-INDEPENDENT and already answers every call
  // whose text fits, so it is cached once per text + font and shared across
  // every cap. Without this, a cap that moves for reasons unrelated to the text
  // — an object card's key column widening as a sibling key is typed, a link
  // gaining a favicon, verticalMove asking for `Infinity` — would miss the
  // cache for every row/node it touches and re-measure text that never changed.
  const natural = wrapAt(text, fontSize, bold, Infinity);
  if (natural.width <= maxWidth) return natural;
  return wrapAt(text, fontSize, bold, maxWidth);
}

function wrapAt(
  text: string,
  fontSize: number,
  bold: boolean,
  maxWidth: number
): WrappedText {
  const key = `${fontSize}|${bold ? 1 : 0}|${maxWidth}|${text}`;
  const cached = _wrapCache.get(key);
  if (cached) return cached;

  const font = nodeFontString(fontSize, bold);
  const lines: string[] = [];
  const lineStarts: number[] = [];
  let width = 0;
  let base = 0;
  for (const hard of text.split("\n")) {
    for (const p of wrapOneLine(hard, font, fontSize, maxWidth)) {
      lines.push(p.text);
      lineStarts.push(base + p.start);
      width = Math.max(width, p.width);
    }
    base += hard.length + 1; // +1 for the consumed "\n"
  }

  const wrapped: WrappedText = {
    lines,
    lineStarts,
    width,
    visualText: lines.length === 1 ? lines[0] : lines.join("\n"),
  };
  if (_wrapCache.size > 4000) _wrapCache.clear();
  _wrapCache.set(key, wrapped);
  return wrapped;
}

/**
 * Measure a node's box from its wrapped lines. `opts` defaults to the 14px /
 * normal-weight baseline and the {@link NODE_MAX_CONTENT_WIDTH} cap.
 */
export function measureNodeBox(text: string, opts?: MeasureOpts): NodeBox {
  const wrapped = wrapNodeText(text, opts);
  const hit = _boxCache.get(wrapped);
  if (hit) return hit;
  const lineHeight = lineHeightFor(opts?.fontSize ?? DEFAULT_FONT_SIZE);
  const box: NodeBox = {
    width: wrapped.width,
    height: Math.max(
      MIN_BOX_HEIGHT,
      wrapped.lines.length * lineHeight + BOX_V_PAD
    ),
    lineCount: wrapped.lines.length,
  };
  _boxCache.set(wrapped, box);
  return box;
}
