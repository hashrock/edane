/**
 * Application layer: outline (mobile) view helpers.
 *
 * The mobile layout renders the same document as a vertically-scrolling,
 * indented outline instead of a mind map. These pure helpers derive the visible
 * row list and caret navigation from the model, so the view stays declarative
 * and the logic is unit-testable without a DOM.
 */

import { type MindMapModel, visibleChildrenOf } from "../domain/model";
import { verticalMove } from "../lib/textGeometry";

export interface OutlineRow {
  node: MindMapModel;
  /** Root = 0; its children = 1; grandchildren = 2; … (indent level). */
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
}

/**
 * Visible outline rows in DFS order, INCLUDING the root as the first row (depth
 * 0). The root is still mirrored in the header title, but giving it a real row
 * means caret navigation matches {@link getFlatOrder} (which also starts at the
 * root): pressing ↑ from the first child lands on the root instead of hitting a
 * wall. Descendants of a collapsed node are omitted; the collapsed node itself
 * stays and still reports `hasChildren` so the disclosure control renders.
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
    if (vis.kind === "leaves") {
      // Rows with hidden children report `collapsed` so the count badge
      // renders — see visibleChildrenOf for why this set of nodes matches
      // what the caret can reach.
      for (const c of vis.children) {
        rows.push({
          node: c,
          depth: depth + 1,
          hasChildren: c.children.length > 0,
          collapsed: c.children.length > 0,
        });
      }
      return;
    }
    for (const c of vis.children) walk(c, depth + 1);
  }
  walk(model, 0);
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
