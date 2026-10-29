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

import {
  findNode,
  getFlatOrder,
  getNodeDepths,
  type MindMapDocument,
  type MindMapModel,
} from "../domain/model";

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

export type RangeDir = "left" | "right" | "up" | "down";

/** Line-wise caret move inside a node; null = past the first / last line. */
export type VerticalMove = (text: string, pos: number, dir: -1 | 1) => number | null;

/** A node's text as the range sees it (the edit buffer for the anchor). */
export type TextOf = (id: string) => string;

/**
 * The texts a range is measured against: the live edit buffer for the node
 * being edited (it can run a keystroke ahead of the model), the model's text
 * for every other node.
 */
export function rangeTextOf(
  doc: MindMapDocument,
  editingId: string | null,
  editingText: string
): TextOf {
  return (id) => (id === editingId ? editingText : findNode(doc, id)?.text ?? "");
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
  textOf: TextOf,
  verticalMove: VerticalMove
): TextPoint {
  const text = textOf(point.id);
  const offset = Math.min(Math.max(point.offset, 0), text.length);
  const order = getFlatOrder(doc);
  const idx = order.indexOf(point.id);
  const prevId = idx > 0 ? order[idx - 1] : null;
  const nextId = idx >= 0 && idx < order.length - 1 ? order[idx + 1] : null;
  switch (dir) {
    case "left":
      if (offset > 0) return { id: point.id, offset: charStep(text, offset, -1) };
      return prevId ? { id: prevId, offset: textOf(prevId).length } : { id: point.id, offset };
    case "right":
      if (offset < text.length) return { id: point.id, offset: charStep(text, offset, 1) };
      return nextId ? { id: nextId, offset: 0 } : { id: point.id, offset };
    case "up": {
      const moved = verticalMove(text, offset, -1);
      if (moved !== null) return { id: point.id, offset: moved };
      if (!prevId) return { id: point.id, offset: 0 };
      const prev = textOf(prevId);
      const lastLine = prev.lastIndexOf("\n") + 1;
      return {
        id: prevId,
        offset: lastLine + Math.min(columnOf(text, offset), prev.length - lastLine),
      };
    }
    case "down": {
      const moved = verticalMove(text, offset, 1);
      if (moved !== null) return { id: point.id, offset: moved };
      if (!nextId) return { id: point.id, offset: text.length };
      const next = textOf(nextId);
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
  textOf: TextOf,
  sel: { pos: number; selEnd: number; backward: boolean },
  dir: RangeDir,
  verticalMove: VerticalMove
): TextRange | null {
  const focusOffset = sel.backward ? sel.pos : sel.selEnd;
  const anchorOffset = sel.backward ? sel.selEnd : sel.pos;
  const focus = stepPoint(doc, { id: anchorId, offset: focusOffset }, dir, textOf, verticalMove);
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

/**
 * The covered `[from, to)` offsets of every visible node the range touches,
 * in reading order: the start node from its offset to its end, the nodes in
 * between whole, the end node up to its offset.
 */
export function rangeSegments(
  doc: MindMapDocument,
  range: TextRange,
  textOf: TextOf
): Map<string, [number, number]> {
  const { start, end } = orderedRange(doc, range);
  const order = getFlatOrder(doc);
  const lo = order.indexOf(start.id);
  const hi = order.indexOf(end.id);
  const segments = new Map<string, [number, number]>();
  if (lo === -1 || hi === -1) return segments;
  for (let i = lo; i <= hi; i++) {
    const id = order[i];
    const len = textOf(id).length;
    const from = i === lo ? Math.min(start.offset, len) : 0;
    const to = i === hi ? Math.min(end.offset, len) : len;
    segments.set(id, [from, Math.max(from, to)]);
  }
  return segments;
}

/** The anchor node's covered segment: what the textarea selects. */
export function anchorSegment(
  doc: MindMapDocument,
  range: TextRange,
  textOf: TextOf
): [number, number] {
  return rangeSegments(doc, range, textOf).get(range.anchor.id) ?? [0, 0];
}

/**
 * The range as plain text — what Cmd+C puts on the clipboard. One line per
 * node (a multi-line node keeps its line breaks), each indented two spaces
 * per level below the shallowest node in the range, so it reads as an
 * outline anywhere and pastes back into edane as the same structure
 * (persistence.textToNodes). The start / end nodes contribute only their
 * covered part, like the first / last line of a textarea selection.
 *
 * A collapsed node's hidden descendants sit between it and the next visible
 * node in this reading, so they are copied whenever the range runs past that
 * node — every node but the end one. Within one node the result is just the
 * selected substring, as a native in-node copy would give.
 */
export function rangeToPlainText(
  doc: MindMapDocument,
  range: TextRange,
  textOf: TextOf
): string {
  const segments = rangeSegments(doc, range, textOf);
  if (segments.size === 1) {
    const [[id, [from, to]]] = segments;
    return textOf(id).slice(from, to);
  }
  const depths = getNodeDepths(doc);
  const entries: { depth: number; text: string }[] = [];
  const hidden = (n: MindMapModel) => {
    for (const child of n.children) {
      entries.push({ depth: depths.get(child.id) ?? 0, text: child.text });
      hidden(child);
    }
  };
  const ids = [...segments.keys()];
  ids.forEach((id, i) => {
    const [from, to] = segments.get(id)!;
    entries.push({ depth: depths.get(id) ?? 0, text: textOf(id).slice(from, to) });
    const node = findNode(doc, id);
    if (node?.collapsed && i < ids.length - 1) hidden(node);
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
