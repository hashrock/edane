/**
 * Application layer: block-level Markdown layout for the canvas.
 *
 * A markdown node stores a whole document in `text`. Instead of drawing that raw
 * source, {@link layoutMarkdown} parses it into a bounded list of styled lines —
 * headings sized and bold, list items with bullets/numbers, blockquotes with a
 * gutter bar, fenced code in monospace, horizontal rules — and stacks them so
 * the canvas can draw each line with its own font while the box grows to fit.
 *
 * Inline emphasis (`**bold**`, `*em*`, `` `code` ``, links) is stripped to plain
 * text via {@link stripInline}; block-level structure is what this renders. Both
 * the layout measurement (node box) and the canvas draw read the SAME layout, so
 * the box can never drift from what is shown.
 *
 * Pure except for text measurement (measureNodeBox falls back to an estimate off
 * the DOM), matching the rest of the sizing pipeline.
 */

import { measureNodeBox, lineHeightFor, DEFAULT_FONT_SIZE } from "../lib/measureText";
import { stripInline, HEADING, UNORDERED, BLOCKQUOTE, HR, FENCE } from "./markdown";

/** Cap on rendered lines so a large paste can't produce a giant box. */
const MAX_LINES = 14;
/** Max characters per rendered line before ellipsis. */
const MAX_LINE_LEN = 80;
/** Indent (px) per list-nesting level (2 source spaces = one level). */
const INDENT_PER_LEVEL = 16;
/** Left indent (px) for a blockquote's text, past its gutter bar. */
const QUOTE_INDENT = 12;
/** Heading font-size multipliers by level (h1..h6). */
const HEADING_SCALE = [1.7, 1.45, 1.28, 1.14, 1.0, 0.9];

// Local: needs the number captured (group 2), unlike markdown.ts's ORDERED.
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;

/** One rendered line with its resolved block-level style. */
export interface MdLine {
  /** Display text (inline markers stripped). Empty for a rule. */
  text: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  mono: boolean;
  /** Text fill colour (hex). */
  color: string;
  /** Left indent (px) from the content's left edge. */
  indent: number;
  /** List marker drawn in the indent gutter (e.g. "•" or "3."), if any. */
  bullet?: string;
  /** Draw a horizontal rule instead of text. */
  rule?: boolean;
  /** Draw a blockquote gutter bar to the left of the text. */
  gutter?: boolean;
  /** Tint the line's background as a code block. */
  codeBg?: boolean;
}

/** A laid-out line: its style plus resolved geometry. */
export interface PositionedMdLine extends MdLine {
  /** Top offset (px) of this line within the content block. */
  y: number;
  /** Line box height (px). */
  height: number;
  /** Measured text width (px), excluding indent/bullet. */
  textWidth: number;
  /** X offset (px) where the text starts: indent + bullet gutter. */
  textOffset: number;
}

export interface MdLayout {
  lines: PositionedMdLine[];
  /** Content width (px): the widest line's right edge. */
  width: number;
  /** Content height (px): the sum of line heights. */
  height: number;
}

const TEXT_COLOR = "#334155";
const HEADING_COLOR = "#1e293b";
const QUOTE_COLOR = "#64748b";
const CODE_COLOR = "#0f172a";

function clip(s: string): string {
  return s.length > MAX_LINE_LEN ? s.slice(0, MAX_LINE_LEN) + "…" : s;
}

/**
 * Parse Markdown source into styled lines (block level only). Fenced code blocks
 * keep their raw content as monospace lines; the fence markers are dropped.
 */
export function parseMarkdownLines(text: string, base: number): MdLine[] {
  // One factory for all lines: fills the shared defaults, callers override only
  // what differs for their block kind.
  const mk = (o: Partial<MdLine> = {}): MdLine => ({
    text: "",
    fontSize: base,
    bold: false,
    italic: false,
    mono: false,
    color: TEXT_COLOR,
    indent: 0,
    ...o,
  });

  const src = text.replace(/\r/g, "").split("\n");
  const out: MdLine[] = [];
  let inFence = false;

  for (const raw of src) {
    if (out.length >= MAX_LINES) break;

    if (FENCE.test(raw)) {
      inFence = !inFence;
      continue; // don't render the fence marker itself
    }
    if (inFence) {
      out.push(
        mk({ text: clip(raw), fontSize: base * 0.92, mono: true, color: CODE_COLOR, codeBg: true })
      );
      continue;
    }

    if (HR.test(raw)) {
      out.push(mk({ rule: true }));
      continue;
    }

    const heading = raw.match(HEADING);
    if (heading) {
      const level = heading[1].length; // 1..6
      out.push(
        mk({
          text: clip(stripInline(heading[2])),
          fontSize: Math.round(base * HEADING_SCALE[level - 1]),
          bold: true,
          color: HEADING_COLOR,
        })
      );
      continue;
    }

    const quote = raw.match(BLOCKQUOTE);
    if (quote) {
      out.push(
        mk({
          text: clip(stripInline(quote[1])),
          italic: true,
          color: QUOTE_COLOR,
          indent: QUOTE_INDENT,
          gutter: true,
        })
      );
      continue;
    }

    const ordered = raw.match(ORDERED);
    if (ordered) {
      const level = Math.floor(ordered[1].replace(/\t/g, "  ").length / 2);
      out.push(
        mk({
          text: clip(stripInline(ordered[3])),
          indent: level * INDENT_PER_LEVEL + 18,
          bullet: `${ordered[2]}.`,
        })
      );
      continue;
    }

    const unordered = raw.match(UNORDERED);
    if (unordered) {
      const level = Math.floor(unordered[1].replace(/\t/g, "  ").length / 2);
      out.push(
        mk({
          text: clip(stripInline(unordered[2])),
          indent: level * INDENT_PER_LEVEL + 16,
          bullet: "•",
        })
      );
      continue;
    }

    // Plain paragraph (or blank line → keep as an empty spacer line).
    out.push(mk({ text: clip(stripInline(raw)) }));
  }

  if (src.length > MAX_LINES && out.length >= MAX_LINES) {
    out[MAX_LINES - 1] = mk({ text: "…", color: QUOTE_COLOR });
  }

  return out.length > 0 ? out : [mk()];
}

/** Width (px) reserved for a bullet/number marker at a given font size. */
function bulletGutter(bullet: string | undefined, fontSize: number): number {
  if (!bullet) return 0;
  return measureNodeBox(bullet + " ", { fontSize }).width;
}

// The draw loop and the node-box measurement both lay out the same markdown on
// every frame; caching by (fontSize, text) means the parse + per-line
// measurement run once per unique document instead of 2–3× per frame. Mirrors
// measureNodeBox's own bounded Map cache.
const _layoutCache = new Map<string, MdLayout>();

/**
 * Lay out a markdown node's rendered lines: parse, measure each line, then stack
 * them vertically. Returns the styled lines with geometry plus the content box
 * (width × height, before the node's own padding).
 */
export function layoutMarkdown(
  text: string,
  baseFontSize = DEFAULT_FONT_SIZE
): MdLayout {
  const base = baseFontSize || DEFAULT_FONT_SIZE;
  const key = `${base}|${text}`;
  const cached = _layoutCache.get(key);
  if (cached) return cached;

  const parsed = parseMarkdownLines(text, base);
  const lines: PositionedMdLine[] = [];
  let y = 0;
  let width = 0;

  for (const line of parsed) {
    const height = lineHeightFor(line.fontSize);
    const textWidth =
      line.rule || line.text === ""
        ? 0
        : measureNodeBox(line.text, {
            fontSize: line.fontSize,
            bold: line.bold,
            mono: line.mono,
          }).width;
    const gutter = bulletGutter(line.bullet, line.fontSize);
    const textOffset = line.indent + gutter;
    const right = line.rule
      ? 120 // rules get a fixed nominal width; the box min-width covers small nodes
      : textOffset + textWidth;
    width = Math.max(width, right);
    lines.push({ ...line, y, height, textWidth, textOffset });
    y += height;
  }

  const result: MdLayout = { lines, width, height: y };
  if (_layoutCache.size > 2000) _layoutCache.clear();
  _layoutCache.set(key, result);
  return result;
}
