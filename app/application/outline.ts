/**
 * Application layer: outline (mobile) view helpers.
 *
 * The mobile layout renders the same document as a vertically-scrolling,
 * indented outline instead of a mind map. These pure helpers derive the visible
 * row list and caret navigation from the model, so the view stays declarative
 * and the logic is unit-testable without a DOM.
 */

import type { MindMapModel } from "../domain/model";

export interface OutlineRow {
  node: MindMapModel;
  /** Root = 0; its children = 1; grandchildren = 2; … (indent level). */
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
}

/**
 * Visible outline rows in DFS order, EXCLUDING the root (the root is the note
 * title, shown in the header). Descendants of a collapsed node are omitted; the
 * collapsed node itself stays and still reports `hasChildren` so the disclosure
 * control renders.
 */
export function outlineRows(model: MindMapModel): OutlineRow[] {
  const rows: OutlineRow[] = [];
  function walk(node: MindMapModel, depth: number) {
    if (depth > 0) {
      rows.push({
        node,
        depth,
        hasChildren: node.children.length > 0,
        collapsed: !!node.collapsed,
      });
    }
    if (node.collapsed) return;
    for (const c of node.children) walk(c, depth + 1);
  }
  walk(model, 0);
  return rows;
}

/**
 * Column-preserving caret move across the hard newlines within a single node's
 * text (mobile textareas keep multi-line nodes). Returns the new absolute
 * offset, or `null` when there is no line in `dir` — the caller then crosses to
 * the previous / next node. Mirrors the canvas editor's `verticalMove` (both
 * split on "\n"), so line navigation behaves the same in either layout.
 */
export function verticalMoveInText(
  text: string,
  pos: number,
  dir: -1 | 1
): number | null {
  const lines = text.split("\n");
  const starts: number[] = [];
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    starts[i] = acc;
    acc += lines[i].length + 1; // +1 for the consumed "\n"
  }
  let line = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (pos >= starts[i]) {
      line = i;
      break;
    }
  }
  const col = pos - starts[line];
  const target = line + dir;
  if (target < 0 || target >= lines.length) return null;
  return starts[target] + Math.min(col, lines[target].length);
}
