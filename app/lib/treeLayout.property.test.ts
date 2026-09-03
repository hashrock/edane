/**
 * Property-based tests for treeLayout: on any forest of any box sizes, the
 * layout must produce non-overlapping boxes — children to the right of their
 * parent, sibling subtrees stacked without touching, each subtree inside its
 * own vertical band, separate trees in separate bands — while honouring
 * user-placed root positions and steering auto-stacked trees clear of them.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { layoutMindMap, layoutRoots, type LayoutNode } from "./treeLayout";

type T = { width: number; height: number; children: T[] };

const tArb: fc.Arbitrary<T> = fc.letrec<{ t: T }>((tie) => ({
  t: fc.record({
    width: fc.integer({ min: 0, max: 400 }),
    height: fc.integer({ min: 0, max: 150 }),
    children: fc.oneof(
      { depthSize: "small", withCrossShrink: true },
      fc.constant([] as T[]),
      fc.array(tie("t"), { maxLength: 3 })
    ),
  }),
})).t;

const positionArb = fc.record({
  x: fc.integer({ min: -1500, max: 1500 }),
  y: fc.integer({ min: -1500, max: 1500 }),
});

interface Forest {
  nodes: LayoutNode[];
  rootOf: Map<string, string>;
}

const forestArb: fc.Arbitrary<Forest> = fc
  .array(fc.tuple(tArb, fc.option(positionArb, { nil: undefined })), { maxLength: 4 })
  .map((roots) => {
    const nodes: LayoutNode[] = [];
    const rootOf = new Map<string, string>();
    let i = 0;
    const walk = (t: T, rootId: string | null, position?: { x: number; y: number }): string => {
      const id = `n${i++}`;
      const node: LayoutNode = { id, width: t.width, height: t.height, children: [], x: 0, y: 0 };
      if (position) node.position = position;
      nodes.push(node);
      rootOf.set(id, rootId ?? id);
      node.children = t.children.map((c) => walk(c, rootId ?? id));
      return id;
    };
    for (const [t, position] of roots) walk(t, null, position);
    return { nodes, rootOf };
  });

type Band = [top: number, bottom: number];
const disjoint = ([aTop, aBottom]: Band, [bTop, bBottom]: Band) => aBottom <= bTop || bBottom <= aTop;

describe("layoutMindMap", () => {
  it("places children right of the parent, siblings in disjoint ordered bands, each inside the parent's band", () => {
    fc.assert(
      fc.property(forestArb, ({ nodes }) => {
        const layout = layoutMindMap(nodes);
        const band = (id: string): Band => {
          const l = layout.get(id)!;
          return [l.y! - l.subtreeHeight / 2, l.y! + l.subtreeHeight / 2];
        };
        for (const parent of nodes) {
          const p = layout.get(parent.id)!;
          const [pTop, pBottom] = band(parent.id);
          let prev: Band | null = null;
          for (const childId of parent.children) {
            const c = layout.get(childId)!;
            expect(c.x!).toBeGreaterThan(p.x! + p.width);
            const b = band(childId);
            expect(b[0]).toBeGreaterThanOrEqual(pTop);
            expect(b[1]).toBeLessThanOrEqual(pBottom);
            if (prev) expect(b[0]).toBeGreaterThan(prev[1]);
            prev = b;
          }
        }
      })
    );
  });

  it("puts placed roots exactly at their position and keeps auto-stacked trees out of every other tree's band", () => {
    fc.assert(
      fc.property(forestArb, ({ nodes }) => {
        const layout = layoutMindMap(nodes);
        const roots = layoutRoots(nodes);
        const band = (id: string): Band => {
          const l = layout.get(id)!;
          return [l.y! - l.subtreeHeight / 2, l.y! + l.subtreeHeight / 2];
        };
        const placed = roots.filter((r) => r.position);
        const auto = roots.filter((r) => !r.position);
        for (const r of placed) {
          expect({ x: r.x, y: r.y }).toEqual(r.position);
        }
        for (const r of auto) {
          for (const p of placed) expect(disjoint(band(r.id), band(p.id))).toBe(true);
        }
        for (let i = 1; i < auto.length; i++) {
          expect(band(auto[i].id)[0]).toBeGreaterThan(band(auto[i - 1].id)[1]);
        }
      })
    );
  });

  it("never overlaps two boxes, except between two user-placed trees", () => {
    fc.assert(
      fc.property(forestArb, ({ nodes, rootOf }) => {
        const layout = layoutMindMap(nodes);
        const placedRoot = new Set(layoutRoots(nodes).filter((r) => r.position).map((r) => r.id));
        const rect = (id: string) => {
          const l = layout.get(id)!;
          return { x: l.x!, y: l.y! - l.height / 2, w: l.width, h: l.height };
        };
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const ra = rootOf.get(nodes[i].id)!;
            const rb = rootOf.get(nodes[j].id)!;
            if (ra !== rb && placedRoot.has(ra) && placedRoot.has(rb)) continue;
            const a = rect(nodes[i].id);
            const b = rect(nodes[j].id);
            const overlap =
              a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
            expect(overlap, `${nodes[i].id} vs ${nodes[j].id}`).toBe(false);
          }
        }
      })
    );
  });
});
