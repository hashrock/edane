/**
 * resolveDropTarget on random laid-out trees and random pointers. The rules
 * its doc comment states, as properties:
 *  - never lands inside the dragged branch (the parent is neither the dragged
 *    node nor one of its visible descendants);
 *  - the parent exists (a laid-out node or the document root) and a sibling
 *    index is within the parent's children;
 *  - a top-level node has no sibling zones (a sibling of a tree root would be
 *    a new tree), so a "sibling" target never has the document root as parent;
 *  - a "child" target's highlighted node is the parent itself;
 *  - it never returns a no-op: applying the target with `moveBranch` always
 *    produces a different model (moveBranch itself returns the same reference
 *    for impossible or no-op moves — the two must agree);
 *  - nothing under the pointer → null.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { findNode, moveBranch, type MindMapModel } from "../domain/model";
import { modelArb, pick } from "../domain/model.arb";
import { resolveDropTarget, type DropRoot } from "./dragDrop";
import { flattenToNodes, nodeBoxHeight, nodeBoxWidth, type MindMapNode } from "./nodeUtils";
import { layoutMindMap } from "../lib/treeLayout";

interface Scene {
  model: MindMapModel;
  nodes: MindMapNode[];
  parentOf: Map<string, string>;
  root: DropRoot;
  draggedId: string;
  excluded: Set<string>;
}

/** Lay a random document out for real and pick a visible node to drag. */
const sceneArb: fc.Arbitrary<Scene> = fc.tuple(modelArb, fc.nat()).map(([model, n]) => {
  const nodes = flattenToNodes(model);
  layoutMindMap(nodes);
  const root: DropRoot = { id: model.id, children: model.children.map((c) => c.id) };
  const parentOf = new Map<string, string>();
  for (const node of nodes) for (const c of node.children) parentOf.set(c, node.id);
  for (const c of root.children) parentOf.set(c, root.id);
  const draggedId = pick(nodes, n).id;
  const excluded = new Set<string>();
  const byId = new Map(nodes.map((x) => [x.id, x]));
  const mark = (id: string) => {
    excluded.add(id);
    for (const c of byId.get(id)?.children ?? []) mark(c);
  };
  mark(draggedId);
  return { model, nodes, parentOf, root, draggedId, excluded };
});

type Pointer =
  | { kind: "near"; n: number; fx: number; fy: number }
  | { kind: "anywhere"; x: number; y: number };

/** A pointer aimed at (or just around) one node's drawn box, or anywhere. */
const pointerArb: fc.Arbitrary<Pointer> = fc.oneof(
  fc.record({
    kind: fc.constant("near" as const),
    n: fc.nat(),
    fx: fc.double({ min: -0.2, max: 1.2, noNaN: true }),
    fy: fc.double({ min: -0.3, max: 1.3, noNaN: true }),
  }),
  fc.record({
    kind: fc.constant("anywhere" as const),
    x: fc.integer({ min: -500, max: 3000 }),
    y: fc.integer({ min: -500, max: 3000 }),
  })
);

function pointerAt(scene: Scene, p: Pointer): { x: number; y: number } {
  if (p.kind === "anywhere") return { x: p.x, y: p.y };
  const node = pick(scene.nodes, p.n);
  const w = nodeBoxWidth(node.width, node.depth === 0);
  const h = nodeBoxHeight(node.height);
  return { x: node.x + w * p.fx, y: node.y - h / 2 + h * p.fy };
}

describe("resolveDropTarget", () => {
  it("returns a valid, non-no-op target outside the dragged branch, or null", () => {
    fc.assert(
      fc.property(sceneArb, pointerArb, (scene, p) => {
        const { model, nodes, parentOf, root, draggedId, excluded } = scene;
        const { x, y } = pointerAt(scene, p);
        const target = resolveDropTarget(nodes, draggedId, excluded, parentOf, root, x, y);
        if (target === null) return;

        // Outside the dragged subtree, onto something that exists.
        expect(excluded.has(target.parentId)).toBe(false);
        expect(excluded.has(target.targetId)).toBe(false);
        const parentExists = target.parentId === root.id || findNode(model, target.parentId) !== null;
        expect(parentExists).toBe(true);

        if (target.kind === "child") {
          expect(target.targetId).toBe(target.parentId);
        } else {
          expect(target.parentId).not.toBe(root.id); // tree roots have no sibling zones
          expect(parentOf.get(target.targetId)).toBe(target.parentId);
          const siblings = findNode(model, target.parentId)!.children.map((c) => c.id);
          expect(target.index).toBeGreaterThanOrEqual(0);
          expect(target.index).toBeLessThanOrEqual(siblings.length);
          const at = siblings.indexOf(target.targetId);
          expect(target.index).toBe(target.position === "before" ? at : at + 1);
        }

        // Applying it is a real move: never impossible, never a no-op.
        const moved =
          target.kind === "child"
            ? moveBranch(model, draggedId, target.parentId)
            : moveBranch(model, draggedId, target.parentId, target.index);
        expect(moved).not.toBe(model);
      })
    );
  });

  it("is null when the pointer is outside every visible box (with slack)", () => {
    fc.assert(
      fc.property(sceneArb, fc.integer({ min: -500, max: 3000 }), fc.integer({ min: -500, max: 3000 }), (scene, x, y) => {
        const { nodes, parentOf, root, draggedId, excluded } = scene;
        const SLACK = 8; // ≥ the largest slack the resolver applies
        const overSomething = nodes.some((node) => {
          const w = nodeBoxWidth(node.width, node.depth === 0);
          const h = nodeBoxHeight(node.height);
          return x >= node.x - SLACK && x <= node.x + w + SLACK && y >= node.y - h / 2 - SLACK && y <= node.y + h / 2 + SLACK;
        });
        const target = resolveDropTarget(nodes, draggedId, excluded, parentOf, root, x, y);
        if (!overSomething) expect(target).toBeNull();
      })
    );
  });
});
