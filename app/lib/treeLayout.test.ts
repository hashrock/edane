import { describe, it, expect } from "vitest";
import type { LayoutNode } from "./treeLayout";
import { layoutMindMap, calculateNodeSizes, assignNodePositions, horizontalGap } from "./treeLayout";

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

  it("does not push unplaced roots out of a placed tree's way", () => {
    // 未配置ルートは配置済みツリーを無視して素直に縦に積む。避けさせると、
    // 木をドロップしたり1行増やしたりするたびに無関係な木が飛ぶ。
    const ns = nodes([
      ["placed", []],
      ["r1", []],
      ["r2", []],
    ]);
    ns[0].position = { x: 100, y: 300 };
    layoutMindMap(ns);
    const m = byId(ns);
    expect([m.placed.x, m.placed.y]).toEqual([100, 300]);
    // r1 は配置済みツリーと同じ位置に重なったままでよい。
    expect([m.r1.x, m.r1.y]).toEqual([100, 300]);
    expect(m.r2.y).toBeGreaterThan(m.r1.y + 32);
  });
});

describe("layoutMindMap horizontal gap follows the children's fan-out", () => {
  const gapOf = (ns: LayoutNode[], parent: string, child: string) => {
    const layout = layoutMindMap(ns);
    const p = layout.get(parent)!;
    return layout.get(child)!.x! - (p.x! + p.width);
  };

  it("keeps a single level child close (short, straight connector)", () => {
    const ns = nodes([
      ["root", ["c1"]],
      ["c1", []],
    ]);
    expect(gapOf(ns, "root", "c1")).toBe(horizontalGap(0));
  });

  it("gives a widely fanned parent the full gap", () => {
    const kids = Array.from({ length: 6 }, (_, i) => `c${i}`);
    const ns = nodes([["root", kids], ...kids.map((k): [string, string[]] => [k, []])]);
    expect(gapOf(ns, "root", "c0")).toBe(horizontalGap(1000));
  });

  it("sizes the gap per parent: siblings share a column, a narrow branch stays short", () => {
    const ns = nodes([
      ["root", ["a", "b", "c", "d"]],
      ["a", ["a1"]],
      ["a1", []],
      ["b", []],
      ["c", []],
      ["d", []],
    ]);
    const layout = layoutMindMap(ns);
    const xs = new Set(["a", "b", "c", "d"].map((id) => layout.get(id)!.x));
    expect(xs.size).toBe(1);
    expect(gapOf(ns, "a", "a1")).toBeLessThan(gapOf(ns, "root", "a"));
  });

  it("is monotone and bounded in the spread", () => {
    let prev = horizontalGap(0);
    for (let s = 0; s <= 500; s += 1) {
      const g = horizontalGap(s);
      expect(g).toBeGreaterThanOrEqual(prev);
      expect(g).toBeLessThanOrEqual(100);
      prev = g;
    }
  });
});

describe("layoutMindMap branch spacing setting", () => {
  const kids = Array.from({ length: 6 }, (_, i) => `c${i}`);
  const spec = (): LayoutNode[] =>
    nodes([["root", ["a", ...kids]], ["a", ["a1"]], ["a1", []], ...kids.map((k): [string, string[]] => [k, []])]);
  const gap = (spacing: "compact" | "normal" | "wide", parent: string, child: string) => {
    const layout = layoutMindMap(spec(), spacing);
    const p = layout.get(parent)!;
    return layout.get(child)!.x! - (p.x! + p.width);
  };

  it("never packs a looser setting tighter than a tighter one", () => {
    for (const [parent, child] of [["root", "a"], ["a", "a1"]] as const) {
      expect(gap("compact", parent, child)).toBeLessThanOrEqual(gap("normal", parent, child));
      expect(gap("normal", parent, child)).toBeLessThanOrEqual(gap("wide", parent, child));
    }
  });

  it("'wide' keeps the historical fixed 120px gap regardless of fan-out", () => {
    expect(gap("wide", "root", "a")).toBe(120);
    expect(gap("wide", "a", "a1")).toBe(120);
  });
});
