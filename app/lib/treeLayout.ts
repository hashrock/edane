import type { MindMapNode } from "../types/MindMap";

interface NodeLayout {
  node: MindMapNode;
  width: number;
  height: number;
  subtreeHeight: number;
  x?: number;
  y?: number;
}

const NODE_HEIGHT = 40;
const NODE_MIN_WIDTH = 100;
const NODE_PADDING = 20;
const HORIZONTAL_GAP = 120;
const VERTICAL_GAP = 10;

function getNodeWidth(text: string): number {
  if (text === "") return 60;
  return Math.max(NODE_MIN_WIDTH, text.length * 8 + NODE_PADDING * 2);
}

export function calculateNodeSizes(
  nodes: MindMapNode[]
): Map<string, NodeLayout> {
  const layoutMap = new Map<string, NodeLayout>();

  nodes.forEach((node) => {
    layoutMap.set(node.id, {
      node,
      width: getNodeWidth(node.text),
      height: NODE_HEIGHT,
      subtreeHeight: NODE_HEIGHT,
    });
  });

  function calculateSubtreeHeight(nodeId: string): number {
    const layout = layoutMap.get(nodeId);
    if (!layout) return 0;

    const node = layout.node;
    if (node.children.length === 0) {
      return NODE_HEIGHT;
    }

    let totalHeight = 0;
    node.children.forEach((childId, index) => {
      const childHeight = calculateSubtreeHeight(childId);
      totalHeight += childHeight;
      if (index > 0) {
        totalHeight += VERTICAL_GAP;
      }
    });

    layout.subtreeHeight = Math.max(NODE_HEIGHT, totalHeight);
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

    let currentY =
      parentLayout.y - (parentLayout.subtreeHeight - NODE_HEIGHT) / 2;

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
