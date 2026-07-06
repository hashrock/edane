/**
 * Node text measurement using @chenglou/pretext.
 *
 * Computes each node's box width and height *without touching the DOM*
 * (no getBoundingClientRect / reflow). pretext needs a Canvas 2D context for
 * `measureText`, so on environments without one (Node test runner, SSR worker)
 * we fall back to a cheap character-count estimate. The fallback keeps the
 * pure-logic layout tests deterministic and the server render working.
 *
 * Lines only ever break on explicit `\n` here: we lay out with `pre-wrap` and a
 * very large max width, so a node grows horizontally to fit its widest line and
 * vertically by its hard line count.
 */
import {
  prepareWithSegments,
  layout,
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
}
/** Vertical padding added around the text block to form the node box. */
const BOX_V_PAD = 14;
/** Minimum node box height (keeps single-line nodes at their original size). */
const MIN_BOX_HEIGHT = 32;
/** Effectively-unbounded width so wrapping only happens on hard `\n` breaks. */
const NO_WRAP_WIDTH = 100000;

/** Horizontal padding between a node's box edge and its content (px). */
export const NODE_PADDING = 20;

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
  /** Widest line's measured width (px). */
  width: number;
  /** Full box height including vertical padding (px). */
  height: number;
  /** Number of hard-break lines (>= 1). */
  lineCount: number;
}

const _boxCache = new Map<string, NodeBox>();

function canMeasure(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof document.createElement === "function"
  );
}

/** Character-count estimate used when no Canvas 2D context is available. */
function estimateBox(text: string, fontSize: number, lineHeight: number): NodeBox {
  const lines = text.split("\n");
  let maxLen = 0;
  for (const line of lines) maxLen = Math.max(maxLen, line.length);
  const width = maxLen * fontSize * 0.6;
  const lineCount = lines.length;
  return {
    width,
    height: Math.max(MIN_BOX_HEIGHT, lineCount * lineHeight + BOX_V_PAD),
    lineCount,
  };
}

/**
 * Measure a node's box. Cached per text string + font — only the actively
 * edited node's text changes between renders, so every other node is an O(1)
 * hit. `opts` defaults to the 14px / normal-weight baseline.
 */
export function measureNodeBox(text: string, opts?: MeasureOpts): NodeBox {
  const fontSize = opts?.fontSize ?? DEFAULT_FONT_SIZE;
  const bold = opts?.bold ?? false;
  const lineHeight = lineHeightFor(fontSize);
  const key = `${fontSize}|${bold ? 1 : 0}|${text}`;
  const cached = _boxCache.get(key);
  if (cached) return cached;

  let box: NodeBox;
  if (!canMeasure()) {
    box = estimateBox(text, fontSize, lineHeight);
  } else {
    const prepared = prepareWithSegments(text, nodeFontString(fontSize, bold), {
      whiteSpace: "pre-wrap",
    });
    const { lineCount } = layout(prepared, NO_WRAP_WIDTH, lineHeight);
    const lines = Math.max(1, lineCount);
    box = {
      width: measureNaturalWidth(prepared),
      height: Math.max(MIN_BOX_HEIGHT, lines * lineHeight + BOX_V_PAD),
      lineCount: lines,
    };
  }

  if (_boxCache.size > 4000) _boxCache.clear();
  _boxCache.set(key, box);
  return box;
}
