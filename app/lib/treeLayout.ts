/** Minimal node contract required by the layout algorithm. */
export interface LayoutNode {
  id: string;
  width: number;
  height: number;
  children: string[];
  x: number;
  y: number;
  /**
   * Roots only: a user-placed position (box left edge, vertical centre). A
   * root with one is laid out exactly there; roots without are auto-stacked.
   */
  position?: { x: number; y: number };
}

interface NodeLayout {
  node: LayoutNode;
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
// Gap between the trees of a multi-root document (larger than the sibling gap
// so separate trees read as separate).
const TREE_GAP = 40;

/**
 * Tree roots of the flat array: nodes no other node lists as a child. The
 * document root is not part of the array (it's the title), so a document with
 * several top-level nodes is a forest, laid out as vertically stacked trees in
 * array order.
 */
export function layoutRoots(nodes: LayoutNode[]): LayoutNode[] {
  const childIds = new Set<string>();
  for (const n of nodes) for (const c of n.children) childIds.add(c);
  return nodes.filter((n) => !childIds.has(n.id));
}

/** Visual box width (measured text width + horizontal padding), with a floor. */
function effectiveWidth(node: LayoutNode): number {
  const textWidth = node.width || 0;
  return Math.max(NODE_MIN_WIDTH, textWidth + NODE_PADDING * 2);
}

/** Slot height used for vertical packing (measured box height, with a floor). */
function slotHeight(node: LayoutNode): number {
  return Math.max(NODE_MIN_HEIGHT, node.height || 0);
}

export function calculateNodeSizes(
  nodes: LayoutNode[]
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

  for (const root of layoutRoots(nodes)) calculateSubtreeHeight(root.id);

  return layoutMap;
}

export function assignNodePositions(
  nodes: LayoutNode[],
  layoutMap: Map<string, NodeLayout>,
  startX: number = 100,
  startY: number = 300
): void {
  if (nodes.length === 0) return;

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

  const roots = layoutRoots(nodes);

  // Placed roots go exactly where the user put them. Their vertical extents
  // are what the auto-stacked roots must steer clear of.
  const placedBands: Array<[top: number, bottom: number]> = [];
  for (const root of roots) {
    if (!root.position) continue;
    const rootLayout = layoutMap.get(root.id);
    if (!rootLayout) continue;
    rootLayout.x = root.position.x;
    rootLayout.y = root.position.y;
    root.x = root.position.x;
    root.y = root.position.y;
    const half = rootLayout.subtreeHeight / 2;
    placedBands.push([root.y - half - TREE_GAP, root.y + half + TREE_GAP]);
    positionChildren(root.id);
  }

  // Unplaced roots stack downward in array order: the first sits at
  // (startX, startY), each further block starts below the previous one plus
  // TREE_GAP. A block that would overlap a placed tree's vertical band is
  // pushed below that band (x is ignored: keeping the auto column clear of
  // every placed tree is simpler to predict than a 2-D packing).
  let blockTop: number | null = null;
  for (const root of roots) {
    if (root.position) continue;
    const rootLayout = layoutMap.get(root.id);
    if (!rootLayout) continue;
    const half = rootLayout.subtreeHeight / 2;
    let top: number = blockTop === null ? startY - half : blockTop;
    for (let moved = true; moved; ) {
      moved = false;
      for (const [bandTop, bandBottom] of placedBands) {
        if (top < bandBottom && top + half * 2 > bandTop) {
          top = bandBottom;
          moved = true;
        }
      }
    }
    rootLayout.x = startX;
    rootLayout.y = top + half;
    root.x = startX;
    root.y = top + half;
    blockTop = top + half * 2 + TREE_GAP;
    positionChildren(root.id);
  }
}

export function layoutMindMap(
  nodes: LayoutNode[]
): Map<string, NodeLayout> {
  const layoutMap = calculateNodeSizes(nodes);
  assignNodePositions(nodes, layoutMap);
  return layoutMap;
}
