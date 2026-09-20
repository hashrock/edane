/**
 * Application layer: drop-target resolution for drag & drop node moves.
 *
 * Pure geometry over the laid-out flat node array — no Konva/DOM — so the
 * child-vs-sibling zoning is unit-testable in node. The box formulas must match
 * the canvas draw exactly, which is why both read them from nodeUtils
 * (nodeBoxWidth / nodeBoxHeight).
 */

import type { MindMapNode } from "./nodeUtils";
import { nodeBoxWidth, nodeBoxHeight } from "./nodeUtils";

/** Where a dragged branch would land if dropped at the current pointer. */
export type DropTarget =
  | {
      /** Drop on a node's body: become its last child. */
      kind: "child";
      parentId: string;
      /** Node whose box to highlight (== parentId). */
      targetId: string;
    }
  | {
      /** Drop on a node's top/bottom edge: become its sibling. */
      kind: "sibling";
      parentId: string;
      /** Insertion index among the parent's current children. */
      index: number;
      /** Node whose edge the insertion line hugs. */
      targetId: string;
      position: "before" | "after";
    };

// Top/bottom edge band that reads as "insert as sibling here" instead of
// "drop into". Capped so tall (multi-line/image) nodes keep a large child zone.
const SIBLING_ZONE_MAX = 12;
// Vertical slack around each box so the gap between siblings (VERTICAL_GAP=10)
// is swallowed by the adjacent edge zones instead of being dead space.
const HIT_SLACK_Y = 5;
// Horizontal slack: a slightly generous box is easier to hit while dragging.
const HIT_SLACK_X = 8;

/**
 * Resolve the drop target under the pointer (world coordinates).
 *
 * `nodes` is the laid-out flat array (roots have depth 0; collapsed nodes
 * appear without their hidden descendants). `excluded` holds the dragged node
 * and its visible descendants. `parentOf` maps child id → parent id for the
 * same array; a root has no entry.
 *
 * A root has no sibling zones — its whole box is a child drop — because a
 * sibling of a root would be a new tree, and trees are only created on
 * purpose (see `isRoot` in domain/model.ts).
 *
 * Returns null over empty space, over an excluded node, or when the resolved
 * position is a no-op (the branch would land exactly where it already is) —
 * so the caller never previews a move that wouldn't change anything.
 */
export function resolveDropTarget(
  nodes: MindMapNode[],
  draggedId: string,
  excluded: Set<string>,
  parentOf: Map<string, string>,
  worldX: number,
  worldY: number
): DropTarget | null {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (excluded.has(node.id)) continue;

    const isRoot = node.depth === 0;
    const w = nodeBoxWidth(node.width, isRoot);
    const h = nodeBoxHeight(node.height);
    const top = node.y - h / 2;
    const bottom = node.y + h / 2;
    if (
      worldX < node.x - HIT_SLACK_X ||
      worldX > node.x + w + HIT_SLACK_X ||
      worldY < top - HIT_SLACK_Y ||
      worldY > bottom + HIT_SLACK_Y
    ) {
      continue;
    }

    const zone = isRoot ? 0 : Math.min(h * 0.3, SIBLING_ZONE_MAX);
    let target: DropTarget;
    if (!isRoot && worldY < top + zone) {
      target = siblingTarget(nodes, parentOf, node.id, "before");
    } else if (!isRoot && worldY > bottom - zone) {
      target = siblingTarget(nodes, parentOf, node.id, "after");
    } else {
      target = { kind: "child", parentId: node.id, targetId: node.id };
    }
    return isNoopFor(nodes, parentOf, draggedId, target) ? null : target;
  }
  return null;
}

/** Children (in order) of a laid-out parent node. */
function childrenOf(
  nodes: MindMapNode[],
  parentId: string
): string[] | undefined {
  return nodes.find((n) => n.id === parentId)?.children;
}

/** Sibling insertion before/after `siblingId` under its parent. */
function siblingTarget(
  nodes: MindMapNode[],
  parentOf: Map<string, string>,
  siblingId: string,
  position: "before" | "after"
): DropTarget {
  // Only non-roots have sibling zones, so the parent always exists here.
  const parentId = parentOf.get(siblingId)!;
  const idx = childrenOf(nodes, parentId)!.indexOf(siblingId);
  return {
    kind: "sibling",
    parentId,
    index: position === "before" ? idx : idx + 1,
    targetId: siblingId,
    position,
  };
}

/** Would this drop leave the dragged branch exactly where it already is? */
function isNoopFor(
  nodes: MindMapNode[],
  parentOf: Map<string, string>,
  draggedId: string,
  target: DropTarget
): boolean {
  // A dragged root has no parent, so nesting it anywhere is always a change.
  const curParentId = parentOf.get(draggedId);
  if (curParentId === undefined || curParentId !== target.parentId) return false;
  const siblings = childrenOf(nodes, curParentId);
  if (!siblings) return false;
  const curIndex = siblings.indexOf(draggedId);
  if (target.kind === "child") {
    return curIndex === siblings.length - 1;
  }
  return target.index === curIndex || target.index === curIndex + 1;
}
