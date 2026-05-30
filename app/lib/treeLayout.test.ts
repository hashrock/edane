import { describe, it, expect } from "vitest";
import type { MindMapNode } from "../types/MindMap";
import { layoutMindMap } from "./treeLayout";

/** Build flat MindMapNode[] (id + children-ids) from a compact spec. */
function nodes(
  spec: Array<[id: string, children: string[]]>
): MindMapNode[] {
  return spec.map(([id, children]) => ({
    id,
    text: id,
    x: 0,
    y: 0,
    children,
  }));
}

function byId(ns: MindMapNode[]): Record<string, MindMapNode> {
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
