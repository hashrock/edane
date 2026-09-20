/**
 * Property-based tests for the tree operations in model.ts.
 *
 * Each operation's doc comment states a structural contract ("children are
 * promoted", "returns the SAME reference when impossible", "a nested node
 * loses its position", …). The example tests in model.test.ts pin those down
 * on hand-written trees; here fast-check checks them on random documents and
 * random target nodes, so a contract can't silently hold only for the shapes
 * someone thought of.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  addChildToNode,
  addRootAt,
  addSiblingAfter,
  cloneModel,
  cloneWithNewIds,
  dedentNode,
  detachBranch,
  findInTree,
  findNode,
  firstRootId,
  getFlatOrder,
  indentNode,
  isRoot,
  locateNode,
  mergeIntoPredecessor,
  mergeSuccessorInto,
  moveBranch,
  moveNodeDown,
  moveNodeUp,
  placeBranchAt,
  removeNode,
  splitNode,
  subtreeIds,
  type MindMapDocument,
  type MindMapModel,
} from "./model";
import {
  allIds,
  expectUniqueIds,
  modelAndNodeArb,
  modelAndVisibleArb,
  modelArb,
  nodeArb,
  nodeIds,
  pick,
  sequentialIds,
} from "./model.arb";

/** id/text/children only — what "the same tree" means when a flag may differ. */
type Shape = { id: string; text: string; children: Shape[] };
function shape(n: MindMapModel): Shape {
  return { id: n.id, text: n.text, children: n.children.map(shape) };
}
function docShape(d: MindMapDocument): Shape[] {
  return d.roots.map(shape);
}
/** Ids of the array a node sits in (its parent's children, or the roots). */
function siblingIds(d: MindMapDocument, parentId: string | null): string[] {
  return (parentId === null ? d.roots : findNode(d, parentId)!.children).map((c) => c.id);
}

describe("getFlatOrder", () => {
  it("lists visible nodes only: unique, no collapsed ancestor, first = firstRootId", () => {
    fc.assert(
      fc.property(modelArb, (model) => {
        const order = getFlatOrder(model);
        expect(new Set(order).size).toBe(order.length);
        expect(order[0]).toBe(firstRootId(model));
        const all = new Set(allIds(model));
        for (const id of order) {
          expect(all.has(id)).toBe(true);
          // Walk up: no strict ancestor may be collapsed.
          for (let loc = locateNode(model, id); loc?.parent; loc = locateNode(model, loc.parent.id)) {
            expect(loc.parent.collapsed).not.toBe(true);
          }
        }
        // And conversely every node without a collapsed ancestor is listed.
        for (const id of nodeIds(model)) {
          let hidden = false;
          for (let loc = locateNode(model, id); loc?.parent; loc = locateNode(model, loc.parent.id)) {
            if (loc.parent.collapsed) hidden = true;
          }
          expect(order.includes(id)).toBe(!hidden);
        }
      })
    );
  });
});

describe("moveBranch", () => {
  it("returns the same reference exactly when the move is impossible or a no-op, otherwise reparents keeping every other order", () => {
    fc.assert(
      fc.property(
        modelArb,
        fc.nat(),
        fc.nat(),
        fc.option(fc.nat({ max: 6 }), { nil: undefined }),
        (model, a, b, index) => {
          const nodeId = pick(nodeIds(model), a);
          const parentId = pick(allIds(model), b);
          const out = moveBranch(model, nodeId, parentId, index);
          const sameRef = out === model;

          const node = findNode(model, nodeId)!;
          const cur = locateNode(model, nodeId)!;
          const impossible = nodeId === parentId || findInTree(node, parentId) !== null;
          const noop =
            cur.parent?.id === parentId &&
            (index === undefined
              ? cur.index === cur.siblings.length - 1
              : index === cur.index || index === cur.index + 1);

          if (impossible || noop) {
            expect(sameRef).toBe(true);
            return;
          }
          expect(sameRef).toBe(false);

          // Same node set, still unique; the moved subtree is intact.
          expect([...allIds(out)].sort()).toEqual([...allIds(model)].sort());
          expectUniqueIds(out);
          const moved = findNode(out, nodeId)!;
          expect(shape(moved)).toEqual(shape(node));
          // It now hangs under the requested parent (which is visible: nestUnder
          // expanded it) …
          const at = locateNode(out, nodeId)!;
          expect(at.parent!.id).toBe(parentId);
          expect(at.parent!.collapsed).toBe(false);
          // … with its canvas position dropped (only a root keeps one).
          expect(moved.position).toBeUndefined();

          // Everyone else keeps their relative order in both containers.
          const others = (m: MindMapDocument, pid: string | null) =>
            siblingIds(m, pid).filter((c) => c !== nodeId);
          expect(others(out, parentId)).toEqual(others(model, parentId));
          expect(others(out, cur.parent?.id ?? null)).toEqual(others(model, cur.parent?.id ?? null));
        }
      )
    );
  });
});

describe("reorder / indent inverses", () => {
  it("moveNodeDown undoes moveNodeUp exactly (and vice versa) — roots included", () => {
    fc.assert(
      fc.property(modelAndNodeArb, fc.boolean(), ({ model, nodeId }, upFirst) => {
        const first = upFirst ? moveNodeUp : moveNodeDown;
        const second = upFirst ? moveNodeDown : moveNodeUp;
        const moved = first(model, nodeId);
        if (moved === model) return; // impossible → same reference, nothing to invert
        expect(moved).not.toEqual(model);
        expect(second(moved, nodeId)).toEqual(model);
      })
    );
  });

  it("dedentNode undoes indentNode up to the previous sibling being expanded and a root's position", () => {
    fc.assert(
      fc.property(modelAndNodeArb, ({ model, nodeId }) => {
        const cur = locateNode(model, nodeId)!;
        const indented = indentNode(model, nodeId);
        if (cur.index === 0) {
          expect(indented).toEqual(model);
          return;
        }
        const prev = cur.siblings[cur.index - 1];
        expect(locateNode(indented, nodeId)!.parent!.id).toBe(prev.id);
        expect(findNode(indented, prev.id)!.collapsed).toBe(false);
        expect(findNode(indented, nodeId)!.position).toBeUndefined();
        expect(docShape(dedentNode(indented, nodeId))).toEqual(docShape(model));
        expectUniqueIds(indented);
      })
    );
  });

  it("dedentNode on a root is a no-op; on a root's child it makes a new root right after the parent", () => {
    fc.assert(
      fc.property(modelAndNodeArb, ({ model, nodeId }) => {
        const cur = locateNode(model, nodeId)!;
        const out = dedentNode(model, nodeId);
        if (cur.parent === null) {
          expect(out).toEqual(model);
          return;
        }
        const grand = locateNode(model, cur.parent.id)!;
        const at = locateNode(out, nodeId)!;
        expect(at.parent?.id ?? null).toBe(grand.parent?.id ?? null);
        expect(at.index).toBe(grand.index + 1);
        expect(isRoot(out, nodeId)).toBe(grand.parent === null);
        expect([...allIds(out)].sort()).toEqual([...allIds(model)].sort());
      })
    );
  });
});

describe("splitNode / merge", () => {
  it("mergeIntoPredecessor on the split-off node restores the tree and reports the split position as caret", () => {
    fc.assert(
      fc.property(modelAndNodeArb, fc.nat(), ({ model, nodeId }, p) => {
        const node = findNode(model, nodeId)!;
        fc.pre(node.text.length > 0);
        const pos = 1 + (p % node.text.length); // 1..len
        const { doc: split, newNodeId } = splitNode(model, nodeId, pos);
        expectUniqueIds(split);
        const kept = findNode(split, nodeId)!;
        expect(kept.text).toBe(node.text.slice(0, pos));
        expect(findNode(split, newNodeId)!.text).toBe(node.text.slice(pos));
        // A root takes the suffix as its first child (no new trees by typing);
        // any other node gets it as the following sibling.
        const at = locateNode(split, newNodeId)!;
        if (isRoot(model, nodeId)) {
          expect(at.parent!.id).toBe(nodeId);
          expect(at.index).toBe(0);
        } else {
          const cur = locateNode(split, nodeId)!;
          expect(at.parent!.id).toBe(cur.parent!.id);
          expect(at.index).toBe(cur.index + 1);
        }

        const merged = mergeIntoPredecessor(split, newNodeId)!;
        expect(merged.targetId).toBe(nodeId);
        expect(merged.caretPos).toBe(pos);
        expect(docShape(merged.doc)).toEqual(docShape(model));
      })
    );
  });

  it("splitting at 0 keeps the node's id, text and children and adds one empty node (before it, or as a root's first child)", () => {
    fc.assert(
      fc.property(modelAndNodeArb, ({ model, nodeId }) => {
        const { doc: split, newNodeId } = splitNode(model, nodeId, 0);
        const before = findNode(model, nodeId)!;
        const after = findNode(split, nodeId)!;
        expect(after.text).toBe(before.text);
        if (isRoot(model, nodeId)) {
          expect(after.children[0].id).toBe(newNodeId);
          expect(after.children.slice(1).map(shape)).toEqual(before.children.map(shape));
        } else {
          expect(shape(after)).toEqual(shape(before));
          const at = locateNode(split, newNodeId)!;
          expect(at.siblings[at.index + 1].id).toBe(nodeId);
        }
        expect(findNode(split, newNodeId)).toEqual({ id: newNodeId, text: "", children: [] });
        expect(allIds(split).length).toBe(allIds(model).length + 1);
        expectUniqueIds(split);
      })
    );
  });

  it("mergeSuccessorInto is a no-op (same reference) exactly when there is no visible child and no next sibling", () => {
    fc.assert(
      fc.property(modelAndNodeArb, ({ model, nodeId }) => {
        const node = findNode(model, nodeId)!;
        const cur = locateNode(model, nodeId)!;
        const hasVisibleChild = !node.collapsed && node.children.length > 0;
        const hasNextSibling = cur.index < cur.siblings.length - 1;
        const out = mergeSuccessorInto(model, nodeId);
        expect(out === model).toBe(!hasVisibleChild && !hasNextSibling);
        if (out === model) return;
        // Exactly one node disappears; everything else survives with unique ids.
        expect(allIds(out).length).toBe(allIds(model).length - 1);
        expectUniqueIds(out);
        expect(findNode(out, nodeId)!.text.startsWith(node.text)).toBe(true);
      })
    );
  });
});

describe("creating and nesting nodes", () => {
  const freshNode = (): MindMapModel => ({
    id: "fresh",
    text: "new",
    children: [],
    position: { x: 1, y: 2 },
  });

  it("addSiblingAfter / splitNode never leave the new node hidden under a collapsed root", () => {
    fc.assert(
      fc.property(modelAndVisibleArb, fc.nat(), ({ model, nodeId }, p) => {
        const added = addSiblingAfter(model, nodeId, freshNode());
        expect(getFlatOrder(added)).toContain("fresh");
        const text = findNode(model, nodeId)!.text;
        const { doc: split, newNodeId } = splitNode(model, nodeId, p % (text.length + 1));
        expect(getFlatOrder(split)).toContain(newNodeId);
      })
    );
  });

  it("a node nested by addSiblingAfter / addChildToNode / indentNode loses its canvas position; only addRootAt keeps one", () => {
    fc.assert(
      fc.property(modelAndNodeArb, ({ model, nodeId }) => {
        expect(findNode(addSiblingAfter(model, nodeId, freshNode()), "fresh")!.position).toBeUndefined();
        expect(findNode(addChildToNode(model, nodeId, freshNode()), "fresh")!.position).toBeUndefined();
        // indentNode returns a clone even for a no-op (first sibling), so ask
        // whether the node actually got nested.
        const indented = indentNode(model, nodeId);
        if (locateNode(indented, nodeId)!.parent?.id !== locateNode(model, nodeId)!.parent?.id) {
          expect(findNode(indented, nodeId)!.position).toBeUndefined();
        }
        // A new tree is placed: that is the one way a position is set.
        const placed = addRootAt(model, freshNode(), { x: 7, y: 8 });
        expect(placed.roots[placed.roots.length - 1].id).toBe("fresh");
        expect(findNode(placed, "fresh")!.position).toEqual({ x: 7, y: 8 });
      })
    );
  });
});

describe("remove / detach / place / clone", () => {
  it("removeNode drops exactly the node and keeps every other node in DFS order (children promoted in place)", () => {
    fc.assert(
      fc.property(modelAndNodeArb, ({ model, nodeId }) => {
        const out = removeNode(model, nodeId);
        expect(allIds(out)).toEqual(allIds(model).filter((id) => id !== nodeId));
        const promoted = findNode(model, nodeId)!.children.map((c) => c.id);
        const parentId = locateNode(model, nodeId)!.parent?.id ?? null;
        for (const id of promoted) {
          expect(locateNode(out, id)!.parent?.id ?? null).toBe(parentId);
        }
      })
    );
  });

  it("detachBranch removes the whole subtree and returns it intact", () => {
    fc.assert(
      fc.property(modelAndNodeArb, ({ model, nodeId }) => {
        const subtree = findNode(model, nodeId)!;
        const { doc: out, removed } = detachBranch(model, nodeId);
        expect(removed).toEqual(subtree);
        const gone = new Set(subtreeIds(subtree));
        expect(allIds(out)).toEqual(allIds(model).filter((id) => !gone.has(id)));
      })
    );
  });

  it("placeBranchAt makes the node a root at the position, keeping its subtree and every id", () => {
    fc.assert(
      fc.property(
        modelAndNodeArb,
        fc.integer({ min: -5000, max: 5000 }),
        fc.integer({ min: -5000, max: 5000 }),
        ({ model, nodeId }, x, y) => {
          const out = placeBranchAt(model, nodeId, { x, y });
          expect(isRoot(out, nodeId)).toBe(true);
          const placed = findNode(out, nodeId)!;
          expect(placed.position).toEqual({ x, y });
          expect(shape(placed)).toEqual(shape(findNode(model, nodeId)!));
          expect([...allIds(out)].sort()).toEqual([...allIds(model)].sort());
          expectUniqueIds(out);
          // Only a nested node moves; a root just gets the position.
          if (isRoot(model, nodeId)) expect(docShape(out)).toEqual(docShape(model));
          else expect(out.roots[out.roots.length - 1].id).toBe(nodeId);
        }
      )
    );
  });

  it("cloneWithNewIds draws ids parent-first in DFS order and changes nothing else; without an id source it mints fresh unique ones", () => {
    fc.assert(
      fc.property(nodeArb, (node) => {
        const strip = (n: MindMapModel): unknown => {
          const { id: _id, children, ...rest } = n;
          return { ...rest, children: children.map(strip) };
        };
        const exact = cloneWithNewIds(node, sequentialIds());
        expect(subtreeIds(exact)).toEqual(subtreeIds(node).map((_, i) => `new${i}`));
        expect(strip(exact)).toEqual(strip(node));

        const copy = cloneWithNewIds(node);
        expect(strip(copy)).toEqual(strip(node));
        const ids = subtreeIds(copy);
        expect(new Set(ids).size).toBe(ids.length);
        const old = new Set(subtreeIds(node));
        for (const id of ids) expect(old.has(id)).toBe(false);
        // Source untouched.
        expect(node).toEqual(cloneModel(node));
      })
    );
  });
});
