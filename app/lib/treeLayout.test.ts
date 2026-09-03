import { describe, it, expect } from "vitest";
import type { LayoutNode } from "./treeLayout";
import { layoutMindMap, calculateNodeSizes, assignNodePositions } from "./treeLayout";

/** Build flat LayoutNode[] (id + children-ids) from a compact spec. */
function nodes(
  spec: Array<[id: string, children: string[]]>
): LayoutNode[] {
  return spec.map(([id, children]) => ({
    id,
    x: 0,
    y: 0,
    children,
    width: 60,
    height: 32,
  }));
}

function byId(ns: LayoutNode[]): Record<string, LayoutNode> {
  return Object.fromEntries(ns.map((n) => [n.id, n]));
}

describe("layoutMindMap vertical centering", () => {
  it("aligns a single child with its parent", () => {
    const ns = nodes([
      ["root", ["c1"]],
      ["c1", []],
    ]);
    layoutMindMap(ns);
    const m = byId(ns);
    expect(m.c1.y).toBe(m.root.y);
  });

  it("centers two children on the parent", () => {
    const ns = nodes([
      ["root", ["c1", "c2"]],
      ["c1", []],
      ["c2", []],
    ]);
    layoutMindMap(ns);
    const m = byId(ns);
    expect(m.c1.y).toBeLessThan(m.root.y);
    expect(m.c2.y).toBeGreaterThan(m.root.y);
    expect((m.c1.y + m.c2.y) / 2).toBeCloseTo(m.root.y, 5);
  });

  it("centers three children on the parent (middle child aligned)", () => {
    const ns = nodes([
      ["root", ["c1", "c2", "c3"]],
      ["c1", []],
      ["c2", []],
      ["c3", []],
    ]);
    layoutMindMap(ns);
    const m = byId(ns);
    expect(m.c2.y).toBeCloseTo(m.root.y, 5);
    expect((m.c1.y + m.c3.y) / 2).toBeCloseTo(m.root.y, 5);
  });

  it("centers each parent on its own children at every level", () => {
    // root -> A -> (A1, A2); root -> B
    const ns = nodes([
      ["root", ["A", "B"]],
      ["A", ["A1", "A2"]],
      ["A1", []],
      ["A2", []],
      ["B", []],
    ]);
    layoutMindMap(ns);
    const m = byId(ns);
    // A centered on its own (equal-height) children
    expect((m.A1.y + m.A2.y) / 2).toBeCloseTo(m.A.y, 5);
    // root centered on the children *block*: with asymmetric subtree heights
    // the parent sits at the midpoint of the topmost and bottommost leaves
    // (their equal half-heights cancel), not the average of direct-child centers.
    expect((m.A1.y + m.B.y) / 2).toBeCloseTo(m.root.y, 5);
  });
});

describe("assignNodePositions edge cases", () => {
  it("returns early when the root node is absent from the layoutMap", () => {
    const ns = nodes([
      ["root", ["c1"]],
      ["c1", []],
    ]);
    const layoutMap = calculateNodeSizes(ns);
    // Remove the root entry so rootLayout is undefined
    layoutMap.delete("root");
    const beforeX = ns[0].x;
    const beforeY = ns[0].y;
    assignNodePositions(ns, layoutMap);
    // Root position must be unchanged (early return triggered)
    expect(ns[0].x).toBe(beforeX);
    expect(ns[0].y).toBe(beforeY);
  });
});

describe("multi-root layout", () => {
  it("stacks unplaced roots downward, first at the start position", () => {
    const ns = nodes([
      ["r1", ["c"]],
      ["c", []],
      ["r2", []],
    ]);
    layoutMindMap(ns);
    const m = byId(ns);
    expect([m.r1.x, m.r1.y]).toEqual([100, 300]);
    expect(m.r2.x).toBe(100);
    expect(m.r2.y).toBeGreaterThan(m.r1.y + 32);
  });

  it("puts a placed root exactly at its position", () => {
    const ns = nodes([
      ["r1", []],
      ["r2", ["c"]],
      ["c", []],
    ]);
    ns[1].position = { x: 900, y: -50 };
    layoutMindMap(ns);
    const m = byId(ns);
    expect([m.r2.x, m.r2.y]).toEqual([900, -50]);
    expect(m.c.y).toBe(-50);
    expect(m.c.x).toBeGreaterThan(900);
    expect([m.r1.x, m.r1.y]).toEqual([100, 300]);
  });

  it("pushes the auto column below a placed tree it would overlap", () => {
    const ns = nodes([
      ["placed", []],
      ["auto", []],
    ]);
    ns[0].position = { x: 100, y: 300 };
    layoutMindMap(ns);
    const m = byId(ns);
    expect(m.auto.y).toBeGreaterThan(300 + 40);
  });
});
