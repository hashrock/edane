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
 * `nodes` is the laid-out flat array (nodes[0] = root; collapsed nodes appear
 * without their hidden descendants). `excluded` holds the dragged node and its
 * visible descendants. `parentOf` maps child id → parent id for the same array.
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

    const isRoot = i === 0;
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

    // A card field row is never a drop-INTO target (its subtree is hidden by
    // the card — the branch would vanish); the whole row resolves to a
    // sibling slot among the card's children instead. The card node itself
    // isn't the row's flat parent (rows are layout leaves), so the slot comes
    // from the row's own child index rather than siblingTarget's parent scan.
    if (node.cardRow) {
      const after = worldY > node.y;
      const target: DropTarget = {
        kind: "sibling",
        parentId: node.cardRow.cardId,
        index: node.cardRow.index + (after ? 1 : 0),
        targetId: node.id,
        position: after ? "after" : "before",
      };
      if (isCardIntoCard(nodes, draggedId, target)) return null;
      return isNoopFor(nodes, parentOf, draggedId, target) ? null : target;
    }

    // Root has no siblings — its whole box is a child drop.
    const zone = isRoot ? 0 : Math.min(h * 0.3, SIBLING_ZONE_MAX);
    let target: DropTarget;
    if (!isRoot && worldY < top + zone) {
      target = siblingTarget(nodes, parentOf, node.id, "before");
    } else if (!isRoot && worldY > bottom - zone) {
      target = siblingTarget(nodes, parentOf, node.id, "after");
    } else {
      target = { kind: "child", parentId: node.id, targetId: node.id };
    }
    if (isCardIntoCard(nodes, draggedId, target)) return null;
    return isNoopFor(nodes, parentOf, draggedId, target) ? null : target;
  }
  return null;
}

/**
 * A card (object node) can't be dropped inside another card: the card renders
 * its children as key:value rows, so a nested card's own subtree would never
 * be shown. Blocks any drop whose resolved parent is an object node when the
 * dragged branch root is itself an object node.
 */
function isCardIntoCard(
  nodes: MindMapNode[],
  draggedId: string,
  target: DropTarget
): boolean {
  const dragged = nodes.find((n) => n.id === draggedId);
  if (dragged?.type !== "object") return false;
  const parent = nodes.find((n) => n.id === target.parentId);
  return parent?.type === "object";
}

/** Sibling insertion before/after `siblingId` under its parent. */
function siblingTarget(
  nodes: MindMapNode[],
  parentOf: Map<string, string>,
  siblingId: string,
  position: "before" | "after"
): DropTarget {
  const parentId = parentOf.get(siblingId)!;
  const parent = nodes.find((n) => n.id === parentId)!;
  const idx = parent.children.indexOf(siblingId);
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
  const curParentId = parentOf.get(draggedId);
  if (curParentId !== target.parentId) return false;
  const parent = nodes.find((n) => n.id === curParentId);
  if (!parent) return false;
  // A card row isn't in its card's flat `children` (rows are layout leaves);
  // its slot comes from cardRow.index instead.
  const dragged = nodes.find((n) => n.id === draggedId);
  const curIndex =
    dragged?.cardRow && dragged.cardRow.cardId === curParentId
      ? dragged.cardRow.index
      : parent.children.indexOf(draggedId);
  if (target.kind === "child") {
    return curIndex === parent.children.length - 1;
  }
  return target.index === curIndex || target.index === curIndex + 1;
}
