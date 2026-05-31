/**
 * Application layer: turn an editor selection into clipboard text.
 */

import { findNode, getFlatOrder, getNodeDepths } from "../domain/model";
import type { MindMapModel } from "../domain/model";
import type { EditorState } from "./editorReducer";

/**
 * Indented plain text for the nodes covered by a multi-node selection
 * (whole nodes, in DFS order). Indentation is normalised so the shallowest
 * selected node sits at column 0, which lets it round-trip back into nodes
 * via `textToModel`.
 */
export function selectionNodesToText(state: EditorState): string {
  const { model, selAnchorNodeId, activeNodeId } = state;
  if (!selAnchorNodeId || !activeNodeId) return "";

  const order = getFlatOrder(model);
  const anchorIdx = order.indexOf(selAnchorNodeId);
  const focusIdx = order.indexOf(activeNodeId);
  if (anchorIdx < 0 || focusIdx < 0) return "";

  const start = Math.min(anchorIdx, focusIdx);
  const end = Math.max(anchorIdx, focusIdx);
  const ids = order.slice(start, end + 1);

  const depths = getNodeDepths(model);
  const base = Math.min(...ids.map((id) => depths.get(id) ?? 0));

  return ids
    .map((id) => {
      const indent = "  ".repeat((depths.get(id) ?? 0) - base);
      return indent + (findNode(model, id)?.text ?? "");
    })
    .join("\n");
}

/**
 * Indented plain text for a single node and its whole subtree (the node at
 * column 0, descendants nested under it). Used when copying a node in
 * selection mode, so it round-trips back into nodes via `textToModel`.
 */
export function nodeSubtreeToText(
  model: MindMapModel,
  nodeId: string
): string {
  const node = findNode(model, nodeId);
  if (!node) return "";
  const lines: string[] = [];
  const walk = (n: MindMapModel, depth: number) => {
    lines.push("  ".repeat(depth) + n.text);
    n.children.forEach((c) => walk(c, depth + 1));
  };
  walk(node, 0);
  return lines.join("\n");
}
