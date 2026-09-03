/**
 * Property-based tests for the tree operations in model.ts.
 *
 * Each operation's doc comment states a structural contract ("children are
 * promoted", "returns the SAME reference when impossible", "a nested node
 * loses its position", …). The example tests in model.test.ts pin those down
 * on hand-written trees; here fast-check checks them on random trees and
 * random target nodes, so a contract can't silently hold only for the shapes
 * someone thought of.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  addChildToNode,
  addSiblingAfter,
  cloneModel,
  cloneWithNewIds,
  dedentNode,
  detachBranch,
  findNode,
  findParentAndIndex,
  firstNavigableId,
  getFlatOrder,
  indentNode,
  isTopLevel,
  mergeIntoPredecessor,
  mergeSuccessorInto,
  moveBranch,
  moveNodeDown,
  moveNodeUp,
  placeBranchAt,
  removeNode,
  splitNode,
  type MindMapModel,
} from "./model";
import {
  allIds,
  expectUniqueIds,
  modelAndNodeArb,
  modelAndVisibleArb,
  modelArb,
  nodeIds,
  pick,
  sequentialIds,
} from "./model.arb";

/** id/text/children only — what "the same tree" means when a flag may differ. */
type Shape = { id: string; text: string; children: Shape[] };
function shape(n: MindMapModel): Shape {
  return { id: n.id, text: n.text, children: n.children.map(shape) };
}

describe("getFlatOrder", () => {
  it("lists visible nodes only: unique, root excluded, no collapsed ancestor, first = firstNavigableId", () => {
    fc.assert(
      fc.property(modelArb, (model) => {
        const order = getFlatOrder(model);
        expect(new Set(order).size).toBe(order.length);
        expect(order).not.toContain(model.id);
        expect(order[0]).toBe(firstNavigableId(model));
        const all = new Set(allIds(model));
        for (const id of order) {
          expect(all.has(id)).toBe(true);
          // Walk up: no strict ancestor may be collapsed.
          for (let info = findParentAndIndex(model, id); info; info = findParentAndIndex(model, info.parent.id)) {
            expect(info.parent.collapsed).not.toBe(true);
          }
        }
        // And conversely every node without a collapsed ancestor is listed.
        for (const id of nodeIds(model)) {
          let hidden = false;
          for (let info = findParentAndIndex(model, id); info; info = findParentAndIndex(model, info.parent.id)) {
            if (info.parent.collapsed) hidden = true;
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
        fc.boolean(),
        fc.option(fc.nat({ max: 6 }), { nil: undefined }),
        (model, a, b, toRoot, index) => {
          const nodeId = pick(nodeIds(model), a);
          const parentId = toRoot ? model.id : pick(allIds(model), b);
          const out = moveBranch(model, nodeId, parentId, index);
          const sameRef = out === model;

          const node = findNode(model, nodeId)!;
          const cur = findParentAndIndex(model, nodeId)!;
          const impossible =
            nodeId === parentId || findNode(node, parentId) !== null;
          const noop =
            cur.parent.id === parentId &&
            (index === undefined
              ? cur.index === cur.parent.children.length - 1
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
          // It now hangs under the requested parent …
          expect(findParentAndIndex(out, nodeId)!.parent.id).toBe(parentId);
          // … with its canvas position dropped unless it became top-level.
          if (parentId !== out.id) expect(moved.position).toBeUndefined();
          else expect(moved.position).toEqual(node.position);

          // Everyone else keeps their relative order in both parents.
          const others = (m: MindMapModel, id: string) =>
            findNode(m, id)!.children.map((c) => c.id).filter((c) => c !== nodeId);
          expect(others(out, parentId)).toEqual(others(model, parentId));
          expect(others(out, cur.parent.id)).toEqual(others(model, cur.parent.id));
        }
      )
    );
  });
});

describe("reorder / indent inverses", () => {
  it("moveNodeDown undoes moveNodeUp exactly (and vice versa)", () => {
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

  it("dedentNode undoes indentNode up to the previous sibling being expanded", () => {
    fc.assert(
      fc.property(modelAndNodeArb, ({ model, nodeId }) => {
        const cur = findParentAndIndex(model, nodeId)!;
        const indented = indentNode(model, nodeId);
        if (cur.index === 0) {
          expect(indented).toEqual(model);
          return;
        }
        const prev = cur.parent.children[cur.index - 1];
        expect(findParentAndIndex(indented, nodeId)!.parent.id).toBe(prev.id);
        expect(findNode(indented, prev.id)!.collapsed).toBe(false);
        expect(shape(dedentNode(indented, nodeId))).toEqual(shape(model));
        expectUniqueIds(indented);
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
        const { model: split, newNodeId } = splitNode(model, nodeId, pos);
        expectUniqueIds(split);
        const kept = findNode(split, nodeId)!;
        expect(kept.text).toBe(node.text.slice(0, pos));
        expect(findNode(split, newNodeId)!.text).toBe(node.text.slice(pos));
        // A tree root takes the suffix as its first child (no new trees by
        // typing); any other node gets it as the following sibling.
        const at = findParentAndIndex(split, newNodeId)!;
        if (isTopLevel(model, nodeId)) {
          expect(at.parent.id).toBe(nodeId);
          expect(at.index).toBe(0);
        } else {
          const cur = findParentAndIndex(split, nodeId)!;
          expect(at.parent.id).toBe(cur.parent.id);
          expect(at.index).toBe(cur.index + 1);
        }

        const merged = mergeIntoPredecessor(split, newNodeId)!;
        expect(merged.targetId).toBe(nodeId);
        expect(merged.caretPos).toBe(pos);
        expect(shape(merged.model)).toEqual(shape(model));
      })
    );
  });

  it("splitting at 0 keeps the node's id, text and children and adds one empty node (before it, or as a tree root's first child)", () => {
    fc.assert(
      fc.property(modelAndNodeArb, ({ model, nodeId }) => {
        const { model: split, newNodeId } = splitNode(model, nodeId, 0);
        const before = findNode(model, nodeId)!;
        const after = findNode(split, nodeId)!;
        expect(after.text).toBe(before.text);
        if (isTopLevel(model, nodeId)) {
          expect(after.children[0].id).toBe(newNodeId);
          expect(after.children.slice(1).map(shape)).toEqual(before.children.map(shape));
        } else {
          expect(shape(after)).toEqual(shape(before));
          const at = findParentAndIndex(split, newNodeId)!;
          expect(at.parent.children[at.index + 1].id).toBe(nodeId);
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
        const cur = findParentAndIndex(model, nodeId)!;
        const hasVisibleChild = !node.collapsed && node.children.length > 0;
        const hasNextSibling = cur.index < cur.parent.children.length - 1;
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

  it("addSiblingAfter / splitNode never leave the new node hidden under a collapsed tree root", () => {
    fc.assert(
      fc.property(modelAndVisibleArb, fc.nat(), ({ model, nodeId }, p) => {
        const added = addSiblingAfter(model, nodeId, freshNode());
        expect(getFlatOrder(added)).toContain("fresh");
        const text = findNode(model, nodeId)!.text;
        const { model: split, newNodeId } = splitNode(model, nodeId, p % (text.length + 1));
        expect(getFlatOrder(split)).toContain(newNodeId);
      })
    );
  });

  it("a node nested by addSiblingAfter / addChildToNode / indentNode loses its canvas position", () => {
    fc.assert(
      fc.property(modelAndNodeArb, ({ model, nodeId }) => {
        expect(findNode(addSiblingAfter(model, nodeId, freshNode()), "fresh")!.position).toBeUndefined();
        expect(findNode(addChildToNode(model, nodeId, freshNode()), "fresh")!.position).toBeUndefined();
        const indented = indentNode(model, nodeId);
        if (indented !== model && !isTopLevel(indented, nodeId)) {
          expect(findNode(indented, nodeId)!.position).toBeUndefined();
        }
        // Only under the root does a node keep it: that makes a new tree.
        expect(findNode(addChildToNode(model, model.id, freshNode()), "fresh")!.position).toEqual({ x: 1, y: 2 });
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
        const parentId = findParentAndIndex(model, nodeId)!.parent.id;
        for (const id of promoted) {
          expect(findParentAndIndex(out, id)!.parent.id).toBe(parentId);
        }
      })
    );
  });

  it("detachBranch removes the whole subtree and returns it intact", () => {
    fc.assert(
      fc.property(modelAndNodeArb, ({ model, nodeId }) => {
        const subtree = findNode(model, nodeId)!;
        const { model: out, removed } = detachBranch(model, nodeId);
        expect(removed).toEqual(subtree);
        const gone = new Set(allIds(subtree));
        expect(allIds(out)).toEqual(allIds(model).filter((id) => !gone.has(id)));
      })
    );
  });

  it("placeBranchAt makes the node a top-level tree at the position, keeping its subtree and every id", () => {
    fc.assert(
      fc.property(
        modelAndNodeArb,
        fc.integer({ min: -5000, max: 5000 }),
        fc.integer({ min: -5000, max: 5000 }),
        ({ model, nodeId }, x, y) => {
          const out = placeBranchAt(model, nodeId, { x, y });
          expect(isTopLevel(out, nodeId)).toBe(true);
          const placed = findNode(out, nodeId)!;
          expect(placed.position).toEqual({ x, y });
          expect(shape(placed)).toEqual(shape(findNode(model, nodeId)!));
          expect([...allIds(out)].sort()).toEqual([...allIds(model)].sort());
          expectUniqueIds(out);
          // Only a nested node moves; a top-level one just gets the position.
          if (isTopLevel(model, nodeId)) expect(shape(out)).toEqual(shape(model));
          else expect(out.children[out.children.length - 1].id).toBe(nodeId);
        }
      )
    );
  });

  it("cloneWithIds draws ids parent-first in DFS order and changes nothing else; cloneWithNewIds mints fresh unique ones", () => {
    fc.assert(
      fc.property(modelArb, (model) => {
        const strip = (n: MindMapModel): unknown => {
          const { id: _id, children, ...rest } = n;
          return { ...rest, children: children.map(strip) };
        };
        const exact = cloneWithNewIds(model, sequentialIds());
        expect(allIds(exact)).toEqual(allIds(model).map((_, i) => `new${i}`));
        expect(strip(exact)).toEqual(strip(model));

        const copy = cloneWithNewIds(model);
        expect(strip(copy)).toEqual(strip(model));
        expectUniqueIds(copy);
        const old = new Set(allIds(model));
        for (const id of allIds(copy)) expect(old.has(id)).toBe(false);
        // Source untouched.
        expect(model).toEqual(cloneModel(model));
      })
    );
  });
});
