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
/** CSS line-height in px for the 14px node font. */
export const LINE_HEIGHT = 18;
/** Vertical padding added around the text block to form the node box. */
const BOX_V_PAD = 14;
/** Minimum node box height (keeps single-line nodes at their original size). */
const MIN_BOX_HEIGHT = 32;
/** Effectively-unbounded width so wrapping only happens on hard `\n` breaks. */
const NO_WRAP_WIDTH = 100000;

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
function estimateBox(text: string): NodeBox {
  const lines = text.split("\n");
  let maxLen = 0;
  for (const line of lines) maxLen = Math.max(maxLen, line.length);
  const width = maxLen * 8;
  const lineCount = lines.length;
  return {
    width,
    height: Math.max(MIN_BOX_HEIGHT, lineCount * LINE_HEIGHT + BOX_V_PAD),
    lineCount,
  };
}

/**
 * Measure a node's box. Cached per text string — only the actively edited
 * node's text changes between renders, so every other node is an O(1) hit.
 */
export function measureNodeBox(text: string): NodeBox {
  const cached = _boxCache.get(text);
  if (cached) return cached;

  let box: NodeBox;
  if (!canMeasure()) {
    box = estimateBox(text);
  } else {
    const prepared = prepareWithSegments(text, NODE_FONT, {
      whiteSpace: "pre-wrap",
    });
    const { lineCount } = layout(prepared, NO_WRAP_WIDTH, LINE_HEIGHT);
    const lines = Math.max(1, lineCount);
    box = {
      width: measureNaturalWidth(prepared),
      height: Math.max(MIN_BOX_HEIGHT, lines * LINE_HEIGHT + BOX_V_PAD),
      lineCount: lines,
    };
  }

  if (_boxCache.size > 4000) _boxCache.clear();
  _boxCache.set(text, box);
  return box;
}
