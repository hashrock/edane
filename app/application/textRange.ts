/**
 * Application layer: a text selection that crosses node boundaries.
 *
 * The plain-text reading of a document is "one node = one line (or a few, for
 * a multi-line node), indentation = depth", walked in the flat order the
 * keyboard already navigates by (getFlatOrder). A range is two points in that
 * reading — `anchor` where it started, `focus` where Shift+arrows have moved
 * it — exactly like a textarea's selection, only the "lines" are nodes.
 *
 * The anchor is always the node being edited (`activeNodeId`), so the keyboard
 * stays on the shared textarea and the keymap keeps handling every key; the
 * focus is a pointer into any visible node. Within the anchor node the
 * textarea itself shows (and reports) the anchor's covered segment — see
 * {@link anchorSegment}.
 *
 * Pure: no DOM, no React, no reducer. The caret geometry within a node comes
 * in as a {@link VerticalMove}, the same one the keymap's ↑/↓ use.
 */

import { getFlatOrder, type MindMapDocument, type MindMapModel } from "../domain/model";
import { drawsOwnText } from "./nodeUtils";
import { nestByDepth } from "./persistence";

export interface TextPoint {
  id: string;
  offset: number;
}

export interface TextRange {
  /** Where the range started: always the node being edited. */
  anchor: TextPoint;
  /** The moving end. May be in the anchor node itself (the range shrank back). */
  focus: TextPoint;
}

/**
 * One Shift+key's worth of movement: a character / line (arrows), the ends
 * of the focus's own line (Shift+Home / End, ⌘/Ctrl+Shift+← / →), or the
 * ends of the whole document (⌘/Ctrl+Shift+↑ / ↓).
 */
export type RangeDir =
  | "left"
  | "right"
  | "up"
  | "down"
  | "lineStart"
  | "lineEnd"
  | "docStart"
  | "docEnd";

/** Line-wise caret move inside a node; null = past the first / last line. */
export type VerticalMove = (text: string, pos: number, dir: -1 | 1) => number | null;

/** What a range reads off the nodes. */
export interface RangeText {
  /** A node's text (the edit buffer for the node being edited). */
  text(id: string): string;
  /**
   * The node is taken whole or not at all: its offsets are only 0 and the
   * end. True for a kind not drawn as its raw text (nodeUtils.drawsOwnText)
   * — except the node being edited, whose textarea shows exactly that text.
   */
  atomic(id: string): boolean;
}

/**
 * The texts a range is measured against: the live edit buffer for the node
 * being edited (it can run a keystroke ahead of the model), the model's text
 * for every other node. One pass over the tree, then constant-time lookups.
 */
export function rangeTextOf(
  doc: MindMapDocument,
  editingId: string | null,
  editingText: string
): RangeText {
  const byId = new Map<string, MindMapModel>();
  const walk = (n: MindMapModel) => {
    byId.set(n.id, n);
    n.children.forEach(walk);
  };
  doc.roots.forEach(walk);
  return {
    text: (id) => (id === editingId ? editingText : byId.get(id)?.text ?? ""),
    atomic: (id) => id !== editingId && !drawsOwnText(byId.get(id)?.type ?? "text"),
  };
}

/** A point inside its node's text; in a node taken whole, at one of its ends. */
export function clampPoint(p: TextPoint, texts: RangeText): TextPoint {
  const len = texts.text(p.id).length;
  const offset = Math.min(Math.max(p.offset, 0), len);
  return { id: p.id, offset: texts.atomic(p.id) && offset > 0 ? len : offset };
}

/** Column of `offset` within its hard line. */
function columnOf(text: string, offset: number): number {
  return offset - (text.lastIndexOf("\n", offset - 1) + 1);
}

/** One character left / right, never splitting a surrogate pair. */
function charStep(text: string, offset: number, dir: -1 | 1): number {
  if (dir === -1) {
    const low = text.charCodeAt(offset - 1);
    const high = text.charCodeAt(offset - 2);
    return low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff
      ? offset - 2
      : offset - 1;
  }
  const high = text.charCodeAt(offset);
  const low = text.charCodeAt(offset + 1);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff
    ? offset + 2
    : offset + 1;
}

/**
 * Where a range end goes for one Shift+arrow. Inside a node it moves like a
 * textarea caret; past the node's edge it crosses to the neighbouring node in
 * flat order, the way a caret crosses a line break: ←/→ to the end / start of
 * the neighbour, ↑/↓ to the same column of the neighbour's adjacent line.
 * At the document's ends it stops at the first / last offset, as Shift+↑ on a
 * textarea's first line selects to its start.
 */
export function stepPoint(
  doc: MindMapDocument,
  point: TextPoint,
  dir: RangeDir,
  texts: RangeText,
  verticalMove: VerticalMove
): TextPoint {
  const text = texts.text(point.id);
  const atomic = texts.atomic(point.id);
  const { offset } = clampPoint(point, texts);
  const order = getFlatOrder(doc);
  const idx = order.indexOf(point.id);
  const prevId = idx > 0 ? order[idx - 1] : null;
  const nextId = idx >= 0 && idx < order.length - 1 ? order[idx + 1] : null;
  const at = (o: number): TextPoint => ({ id: point.id, offset: o });
  switch (dir) {
    case "lineStart":
      return at(atomic ? 0 : text.lastIndexOf("\n", offset - 1) + 1);
    case "lineEnd": {
      const end = text.indexOf("\n", offset);
      return at(atomic || end === -1 ? text.length : end);
    }
    case "docStart":
      return { id: order[0] ?? point.id, offset: 0 };
    case "docEnd": {
      const last = order[order.length - 1] ?? point.id;
      return { id: last, offset: texts.text(last).length };
    }
    case "left":
      if (offset > 0) return at(atomic ? 0 : charStep(text, offset, -1));
      return prevId ? { id: prevId, offset: texts.text(prevId).length } : at(offset);
    case "right":
      if (offset < text.length) return at(atomic ? text.length : charStep(text, offset, 1));
      return nextId ? { id: nextId, offset: 0 } : at(offset);
    // Vertically into a node taken whole, the focus lands past it, so a
    // range growing that way covers it (one shrinking back uncovers it).
    case "up": {
      const moved = atomic ? null : verticalMove(text, offset, -1);
      if (moved !== null) return at(moved);
      if (!prevId) return at(0);
      if (texts.atomic(prevId)) return { id: prevId, offset: 0 };
      const prev = texts.text(prevId);
      const lastLine = prev.lastIndexOf("\n") + 1;
      return {
        id: prevId,
        offset: lastLine + Math.min(columnOf(text, offset), prev.length - lastLine),
      };
    }
    case "down": {
      const moved = atomic ? null : verticalMove(text, offset, 1);
      if (moved !== null) return at(moved);
      if (!nextId) return at(text.length);
      const next = texts.text(nextId);
      if (texts.atomic(nextId)) return { id: nextId, offset: next.length };
      const firstEnd = next.indexOf("\n");
      return {
        id: nextId,
        offset: Math.min(columnOf(text, offset), firstEnd === -1 ? next.length : firstEnd),
      };
    }
  }
}

/**
 * Start a cross-node range from the textarea's own selection, or null when
 * the Shift+arrow stays inside the node (the textarea extends its selection
 * natively then). `backward` is the textarea's selectionDirection: it says
 * which end of `pos..selEnd` is the moving one.
 */
export function beginRange(
  doc: MindMapDocument,
  anchorId: string,
  texts: RangeText,
  sel: { pos: number; selEnd: number; backward: boolean },
  dir: RangeDir,
  verticalMove: VerticalMove
): TextRange | null {
  const focusOffset = sel.backward ? sel.pos : sel.selEnd;
  const anchorOffset = sel.backward ? sel.selEnd : sel.pos;
  const focus = stepPoint(doc, { id: anchorId, offset: focusOffset }, dir, texts, verticalMove);
  if (focus.id === anchorId) return null;
  return { anchor: { id: anchorId, offset: anchorOffset }, focus };
}

/** The range's two points in reading order. */
export function orderedRange(
  doc: MindMapDocument,
  range: TextRange
): { start: TextPoint; end: TextPoint } {
  const order = getFlatOrder(doc);
  const a = order.indexOf(range.anchor.id);
  const f = order.indexOf(range.focus.id);
  const forward = a < f || (a === f && range.anchor.offset <= range.focus.offset);
  return forward
    ? { start: range.anchor, end: range.focus }
    : { start: range.focus, end: range.anchor };
}

/** The part of one node a range covers. */
export interface Segment {
  from: number;
  to: number;
  /** The range runs on past this node: its line break is covered too. */
  breaks: boolean;
}

/**
 * The covered part of every visible node the range touches, in reading
 * order: the start node from its offset to its end, the nodes in between
 * whole, the end node up to its offset.
 */
export function rangeSegments(
  doc: MindMapDocument,
  range: TextRange,
  texts: RangeText
): Map<string, Segment> {
  const { start, end } = orderedRange(doc, range);
  const order = getFlatOrder(doc);
  const lo = order.indexOf(start.id);
  const hi = order.indexOf(end.id);
  const segments = new Map<string, Segment>();
  if (lo === -1 || hi === -1) return segments;
  for (let i = lo; i <= hi; i++) {
    const id = order[i];
    const len = texts.text(id).length;
    const from = i === lo ? Math.min(start.offset, len) : 0;
    const to = i === hi ? Math.min(end.offset, len) : len;
    segments.set(id, { from, to: Math.max(from, to), breaks: i < hi });
  }
  return segments;
}

/** The anchor node's covered segment: what the textarea selects. */
export function anchorSegment(
  doc: MindMapDocument,
  range: TextRange,
  texts: RangeText
): [number, number] {
  const { start, end } = orderedRange(doc, range);
  const { anchor } = range;
  if (start.id === end.id) return [start.offset, end.offset];
  return start === anchor ? [anchor.offset, texts.text(anchor.id).length] : [0, anchor.offset];
}

/**
 * Every node as a line of the plain-text reading — depth-first, hidden
 * subtrees included — and the span of lines from the range's start node to
 * its end node. A collapsed node's hidden descendants sit between it and the
 * next visible node, so they fall inside the span whenever the range runs
 * past that node; the end node's own hidden ones come after it, outside.
 */
function rangeLines(doc: MindMapDocument, range: TextRange) {
  const lines: { node: MindMapModel; depth: number }[] = [];
  const walk = (n: MindMapModel, depth: number) => {
    lines.push({ node: n, depth });
    n.children.forEach((c) => walk(c, depth + 1));
  };
  doc.roots.forEach((r) => walk(r, 0));
  const { start, end } = orderedRange(doc, range);
  const i = lines.findIndex((l) => l.node.id === start.id);
  const j = lines.findIndex((l) => l.node.id === end.id);
  return { lines, start, end, i, j };
}

/**
 * The range as plain text — what Cmd+C puts on the clipboard. One line per
 * node (a multi-line node keeps its line breaks), each indented two spaces
 * per level below the shallowest node in the range, so it reads as an
 * outline anywhere and pastes back into edane as the same structure
 * (persistence.textToNodes). The start / end nodes contribute only their
 * covered part, like the first / last line of a textarea selection; hidden
 * descendants the range runs past are copied whole (see {@link rangeLines}).
 * Within one node the result is just the selected substring, as a native
 * in-node copy would give.
 */
export function rangeToPlainText(
  doc: MindMapDocument,
  range: TextRange,
  texts: RangeText
): string {
  const { lines, start, end, i, j } = rangeLines(doc, range);
  if (i === -1 || j === -1) return "";
  if (i === j) return texts.text(start.id).slice(start.offset, end.offset);
  const entries = lines.slice(i, j + 1).map(({ node, depth }, k) => {
    const text = texts.text(node.id);
    const from = k === 0 ? start.offset : 0;
    const to = k === j - i ? end.offset : text.length;
    return { depth, text: text.slice(from, to) };
  });
  // An empty covered part (a range ending at a node's start, an empty node)
  // prints as a bare line break, so it must not set the indentation either.
  const printed = entries.filter((e) => e.text !== "");
  const base = Math.min(...(printed.length > 0 ? printed : entries).map((e) => e.depth));
  return entries
    .flatMap(({ depth, text }) =>
      text.split("\n").map((line) => (line === "" ? "" : "  ".repeat(depth - base) + line))
    )
    .join("\n");
}

/**
 * Replace a range with `insert` (empty = delete it) — what typing, Backspace,
 * cut and paste do over a selection. The rule is the plain-text reading's:
 * the covered text goes, the start node's head and the end node's tail join
 * into one line on the start node (which keeps its id and depth), and every
 * line after the range keeps its own indentation, so it hangs under whatever
 * shallower line now precedes it (persistence.nestByDepth) — exactly what
 * deleting those characters from the copied text and pasting it back would
 * build. Nodes wholly inside the range go, including the hidden descendants
 * a copy of the range holds.
 *
 * Returns the new document and where the caret lands (after `insert`).
 */
export function replaceRange(
  doc: MindMapDocument,
  range: TextRange,
  texts: RangeText,
  insert: string
): { doc: MindMapDocument; caret: TextPoint } {
  const { lines, start, end, i, j } = rangeLines(doc, range);
  const head = texts.text(start.id).slice(0, start.offset);
  const tail = texts.text(end.id).slice(end.offset);
  const caret = { id: start.id, offset: head.length + insert.length };
  if (i === -1 || j === -1) return { doc, caret };

  const joined: MindMapModel = { ...lines[i].node, text: head + insert + tail };
  // Lines after the range may come to hang under the joined line; it must be
  // open to show them (the nesting rule of nestUnder).
  if (i !== j) delete joined.collapsed;
  const roots = nestByDepth([
    ...lines.slice(0, i),
    { node: joined, depth: lines[i].depth },
    ...lines.slice(j + 1),
  ]);
  return { doc: { ...doc, roots }, caret };
}
