import { describe, it, expect } from "vitest";
import type { MindMapNode } from "./nodeUtils";
import { nodeBoxWidth, nodeBoxHeight } from "./nodeUtils";
import { resolveDropTarget } from "./dragDrop";

/**
 * Hand-laid-out flat array mimicking layoutMindMap's output:
 *
 *   root (x=100, y=300) ── a (x=300, y=250) ── a1 (x=500, y=250)
 *                       └─ b (x=300, y=350)
 *
 * All boxes measure 60×20 → rendered box 100×32 for the root, 100×32 for the
 * rest (nodeBoxWidth floors at 80 + padding → 100; height floors at 32).
 */
function node(
  id: string,
  x: number,
  y: number,
  children: string[]
): MindMapNode {
  return {
    id,
    text: id,
    x,
    y,
    children,
    type: "text",
    width: 60,
    height: 20,
    collapsed: false,
    childCount: children.length,
  };
}

function sampleNodes(): MindMapNode[] {
  return [
    node("root", 100, 300, ["a", "b"]),
    node("a", 300, 250, ["a1"]),
    node("a1", 500, 250, []),
    node("b", 300, 350, []),
  ];
}

function parentMap(nodes: MindMapNode[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const n of nodes) for (const c of n.children) m.set(c, n.id);
  return m;
}

/** resolveDropTarget with the boilerplate filled in. */
function resolve(
  draggedId: string,
  worldX: number,
  worldY: number,
  excluded: string[] = [draggedId]
) {
  const nodes = sampleNodes();
  return resolveDropTarget(
    nodes,
    draggedId,
    new Set(excluded),
    parentMap(nodes),
    worldX,
    worldY
  );
}

// Box geometry shared with the implementation (width 60 → box 100, height 32).
const W = nodeBoxWidth(60, false);
const H = nodeBoxHeight(20);

describe("resolveDropTarget", () => {
  it("resolves a body hit to a child drop", () => {
    // Center of node a.
    expect(resolve("b", 300 + W / 2, 250)).toEqual({
      kind: "child",
      parentId: "a",
      targetId: "a",
    });
  });

  it("resolves a top-edge hit to a sibling-before drop", () => {
    expect(resolve("b", 300 + W / 2, 250 - H / 2 + 2)).toEqual({
      kind: "sibling",
      parentId: "root",
      index: 0,
      targetId: "a",
      position: "before",
    });
  });

  it("resolves a bottom-edge hit to a sibling-after drop", () => {
    expect(resolve("a1", 300 + W / 2, 250 + H / 2 - 2)).toEqual({
      kind: "sibling",
      parentId: "root",
      index: 1,
      targetId: "a",
      position: "after",
    });
  });

  it("swallows the gap just outside the box into the edge zone", () => {
    // 3px below b's bottom edge is still a sibling-after hit (±5px slack).
    expect(resolve("a1", 300 + W / 2, 350 + H / 2 + 3)).toMatchObject({
      kind: "sibling",
      targetId: "b",
      position: "after",
    });
  });

  it("treats the root as child-only (no sibling zones)", () => {
    // A top-edge hit on the root still resolves as a child drop.
    const topEdge = resolve("a1", 100 + W / 2, 300 - H / 2 + 2);
    expect(topEdge).toEqual({ kind: "child", parentId: "root", targetId: "root" });
  });

  it("ignores excluded nodes (dragged subtree)", () => {
    // Pointer over a1 while dragging a (a + a1 excluded) hits nothing.
    expect(resolve("a", 500 + W / 2, 250, ["a", "a1"])).toBeNull();
  });

  it("returns null over empty space", () => {
    expect(resolve("b", 1000, 1000)).toBeNull();
  });

  it("returns null for a no-op child drop (already the last child)", () => {
    // a1 is a's only child; dropping a1 on a's body changes nothing.
    expect(resolve("a1", 300 + W / 2, 250)).toBeNull();
  });

  it("returns null for a no-op sibling drop (current slot)", () => {
    // b before b's own slot / after a — both keep [a, b].
    expect(resolve("b", 300 + W / 2, 350 - H / 2 + 2)).toBeNull();
    expect(resolve("b", 300 + W / 2, 250 + H / 2 - 2)).toBeNull();
  });

  it("still allows a meaningful sibling drop for the dragged node's own edge zones", () => {
    // b dropped before a reorders [a, b] → [b, a].
    expect(resolve("b", 300 + W / 2, 250 - H / 2 + 2)).toMatchObject({
      kind: "sibling",
      index: 0,
      position: "before",
    });
  });
});

describe("resolveDropTarget: cards can't be dropped inside cards", () => {
  // root ── card (object, expanded with one row) , dcard (object, dragged)
  function cardNodes(): MindMapNode[] {
    return [
      { ...node("root", 100, 300, ["card", "dcard"]) },
      { ...node("card", 300, 250, []), type: "object" },
      // A field row belonging to the card (layout leaf, not in card.children).
      // Parked away from the card box so this hit exercises the cardRow branch
      // rather than the card body's child branch.
      {
        ...node("row0", 300, 450, []),
        cardRow: {
          cardId: "card",
          index: 0,
          top: 0,
          key: "k",
          display: "v",
          kind: "text",
          keyColW: 20,
        },
      },
      // The dragged card, parked off-screen so it's never a hit itself.
      { ...node("dcard", 900, 900, []), type: "object" },
    ];
  }

  function resolveIn(
    nodes: MindMapNode[],
    draggedId: string,
    worldX: number,
    worldY: number
  ) {
    return resolveDropTarget(
      nodes,
      draggedId,
      new Set([draggedId]),
      parentMap(nodes),
      worldX,
      worldY
    );
  }

  it("blocks dropping a card onto a card's body (would-be child)", () => {
    const nodes = cardNodes();
    // Body hit on the card box → normally a child drop; blocked for a card.
    expect(resolveIn(nodes, "dcard", 300 + W / 2, 250)).toBeNull();
  });

  it("blocks dropping a card onto a card's field row (would-be child slot)", () => {
    const nodes = cardNodes();
    expect(resolveIn(nodes, "dcard", 300 + W / 2, 450)).toBeNull();
  });

  it("still allows dropping a non-card node into a card", () => {
    const nodes = cardNodes();
    nodes[0].children.push("t");
    nodes.push({ ...node("t", 900, 100, []) }); // a plain text node, dragged
    expect(resolveIn(nodes, "t", 300 + W / 2, 250)).toMatchObject({
      parentId: "card",
    });
  });
});
