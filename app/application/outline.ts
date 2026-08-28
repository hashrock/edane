/**
 * Application layer: outline (mobile) view helpers.
 *
 * The mobile layout renders the same document as a vertically-scrolling,
 * indented outline instead of a mind map. These pure helpers derive the visible
 * row list and caret navigation from the model, so the view stays declarative
 * and the logic is unit-testable without a DOM.
 */

import {
  type MindMapModel,
  topLevelNodes,
  visibleChildrenOf,
} from "../domain/model";
import { verticalMove } from "../lib/textGeometry";

export interface OutlineRow {
  node: MindMapModel;
  /** Top-level nodes = 0; their children = 1; … (indent level). */
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
}

/**
 * Visible outline rows in DFS order, starting at the top-level nodes (depth 0).
 * The root is the note title, shown in the header, and is not a row — the same
 * rule as {@link getFlatOrder}, so caret navigation and the row list agree.
 * Descendants of a collapsed node are omitted; the collapsed node itself stays
 * and still reports `hasChildren` so the disclosure control renders.
 */
export function outlineRows(model: MindMapModel): OutlineRow[] {
  const rows: OutlineRow[] = [];
  function walk(node: MindMapModel, depth: number) {
    rows.push({
      node,
      depth,
      hasChildren: node.children.length > 0,
      collapsed: !!node.collapsed,
    });
    const vis = visibleChildrenOf(node);
    if (vis.kind === "none") return;
    for (const c of vis.children) walk(c, depth + 1);
  }
  for (const top of topLevelNodes(model)) walk(top, 0);
  return rows;
}

/**
 * Column-preserving caret move across the hard newlines within a single node's
 * text (mobile textareas keep multi-line nodes). Returns the new absolute
 * offset, or `null` when there is no line in `dir` — the caller then crosses to
 * the previous / next node. Re-exports the canvas editor's `verticalMove` from
 * lib/textGeometry so both layouts navigate lines with the exact same
 * algorithm instead of two copies that could silently drift apart.
 */
export const verticalMoveInText = verticalMove;
