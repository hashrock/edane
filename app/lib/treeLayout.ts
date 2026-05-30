import type { MindMapNode } from "../types/MindMap";

interface NodeLayout {
  node: MindMapNode;
  width: number;
  height: number;
  subtreeHeight: number;
  x?: number;
  y?: number;
}

// Slot floor so single-line nodes keep their original vertical rhythm.
const NODE_MIN_HEIGHT = 40;
const NODE_MIN_WIDTH = 100;
const NODE_PADDING = 20;
const HORIZONTAL_GAP = 120;
const VERTICAL_GAP = 10;

/** Visual box width (measured text width + horizontal padding), with a floor. */
function effectiveWidth(node: MindMapNode): number {
  const textWidth = node.width || 0;
  return Math.max(NODE_MIN_WIDTH, textWidth + NODE_PADDING * 2);
}

/** Slot height used for vertical packing (measured box height, with a floor). */
function slotHeight(node: MindMapNode): number {
  return Math.max(NODE_MIN_HEIGHT, node.height || 0);
}

export function calculateNodeSizes(
  nodes: MindMapNode[]
): Map<string, NodeLayout> {
  const layoutMap = new Map<string, NodeLayout>();

  nodes.forEach((node) => {
    layoutMap.set(node.id, {
      node,
      width: effectiveWidth(node),
      height: slotHeight(node),
      subtreeHeight: slotHeight(node),
    });
  });

  function calculateSubtreeHeight(nodeId: string): number {
    const layout = layoutMap.get(nodeId);
    if (!layout) return 0;

    const node = layout.node;
    if (node.children.length === 0) {
      layout.subtreeHeight = layout.height;
      return layout.subtreeHeight;
    }

    let childrenHeight = 0;
    node.children.forEach((childId, index) => {
      childrenHeight += calculateSubtreeHeight(childId);
      if (index > 0) childrenHeight += VERTICAL_GAP;
    });

    // A tall (multi-line) parent must not be shorter than its own box.
    layout.subtreeHeight = Math.max(layout.height, childrenHeight);
    return layout.subtreeHeight;
  }

  if (nodes.length > 0) {
    calculateSubtreeHeight(nodes[0].id);
  }

  return layoutMap;
}

export function assignNodePositions(
  nodes: MindMapNode[],
  layoutMap: Map<string, NodeLayout>,
  startX: number = 100,
  startY: number = 300
): void {
  if (nodes.length === 0) return;

  const root = nodes[0];
  const rootLayout = layoutMap.get(root.id);
  if (!rootLayout) return;

  rootLayout.x = startX;
  rootLayout.y = startY;
  root.x = startX;
  root.y = startY;

  function positionChildren(parentId: string) {
    const parentLayout = layoutMap.get(parentId);
    if (
      !parentLayout ||
      parentLayout.x === undefined ||
      parentLayout.y === undefined
    )
      return;

    const parent = parentLayout.node;
    if (parent.children.length === 0) return;

    // Total height occupied by the children block (sum of subtrees + gaps).
    let childrenBlock = 0;
    parent.children.forEach((childId, index) => {
      const childLayout = layoutMap.get(childId);
      if (!childLayout) return;
      childrenBlock += childLayout.subtreeHeight;
      if (index > 0) childrenBlock += VERTICAL_GAP;
    });

    // Top of the children block, centered vertically on the parent.
    let currentY = parentLayout.y - childrenBlock / 2;

    parent.children.forEach((childId) => {
      const childLayout = layoutMap.get(childId);
      if (!childLayout) return;

      const child = childLayout.node;

      childLayout.x =
        (parentLayout.x ?? 0) + parentLayout.width + HORIZONTAL_GAP;
      childLayout.y = currentY + childLayout.subtreeHeight / 2;

      child.x = childLayout.x;
      child.y = childLayout.y;

      currentY += childLayout.subtreeHeight + VERTICAL_GAP;

      positionChildren(childId);
    });
  }

  positionChildren(root.id);
}

export function layoutMindMap(
  nodes: MindMapNode[]
): Map<string, NodeLayout> {
  const layoutMap = calculateNodeSizes(nodes);
  assignNodePositions(nodes, layoutMap);
  return layoutMap;
}
