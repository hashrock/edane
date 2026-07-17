import { describe, it, expect } from "vitest";
import type { MindMapModel, NodeType, NumFormat } from "./model";
import {
  detachBranch,
  cloneWithNewIds,
  findNode,
  getFlatOrder,
  getNodeDepths,
  visibleChildrenOf,
  addSiblingAfter,
  splitNode,
  updateNodeText,
  setNodeType,
  setNodeStyle,
  setLinkMeta,
  toggleCollapse,
  addChildToNode,
  removeNode,
  indentNode,
  dedentNode,
  moveNodeUp,
  moveNodeDown,
  moveBranch,
  mergeIntoPredecessor,
  mergeSuccessorInto,
  isStoredNodeType,
  isNumFormat,
} from "./model";

/** Build a small fixed tree:
 *  Root
 *    A
 *      A1
 *        A1a
 *    B
 */
function sampleModel(): MindMapModel {
  return {
    id: "root",
    text: "Root",
    children: [
      {
        id: "a",
        text: "A",
        type: "link",
        linkTitle: "Anchor",
        children: [
          {
            id: "a1",
            text: "A1",
            fontSize: 20,
            bold: true,
            children: [{ id: "a1a", text: "A1a", children: [] }],
          },
        ],
      },
      { id: "b", text: "B", children: [] },
    ],
  };
}

describe("detachBranch", () => {
  it("removes a node together with all its descendants", () => {
    const model = sampleModel();
    const { model: next } = detachBranch(model, "a");
    // "a" and its whole subtree are gone (children are NOT promoted)
    expect(findNode(next, "a")).toBeNull();
    expect(findNode(next, "a1")).toBeNull();
    expect(findNode(next, "a1a")).toBeNull();
    // siblings untouched
    expect(getFlatOrder(next)).toEqual(["root", "b"]);
  });

  it("returns the removed subtree intact", () => {
    const model = sampleModel();
    const { removed } = detachBranch(model, "a");
    expect(removed).not.toBeNull();
    expect(removed!.id).toBe("a");
    expect(removed!.children[0].id).toBe("a1");
    expect(removed!.children[0].children[0].id).toBe("a1a");
    // formatting/type preserved
    expect(removed!.type).toBe("link");
    expect(removed!.children[0].fontSize).toBe(20);
  });

  it("is a no-op on the root (cannot detach the root)", () => {
    const model = sampleModel();
    const { model: next, removed } = detachBranch(model, "root");
    expect(removed).toBeNull();
    expect(getFlatOrder(next)).toEqual(getFlatOrder(model));
  });

  it("returns removed: null for an unknown node", () => {
    const model = sampleModel();
    const { removed } = detachBranch(model, "missing");
    expect(removed).toBeNull();
  });

  it("does not mutate the original model", () => {
    const model = sampleModel();
    const before = JSON.stringify(model);
    detachBranch(model, "a");
    expect(JSON.stringify(model)).toBe(before);
  });
});

describe("cloneWithNewIds", () => {
  it("preserves text, type and formatting", () => {
    const node = findNode(sampleModel(), "a")!;
    const clone = cloneWithNewIds(node);
    expect(clone.text).toBe("A");
    expect(clone.type).toBe("link");
    expect(clone.linkTitle).toBe("Anchor");
    expect(clone.children[0].fontSize).toBe(20);
    expect(clone.children[0].bold).toBe(true);
  });

  it("preserves the subtree structure", () => {
    const node = findNode(sampleModel(), "a")!;
    const clone = cloneWithNewIds(node);
    expect(clone.children[0].text).toBe("A1");
    expect(clone.children[0].children[0].text).toBe("A1a");
  });

  it("assigns a fresh id to every node (no overlap with the source)", () => {
    const node = findNode(sampleModel(), "a")!;
    const clone = cloneWithNewIds(node);
    const sourceIds = new Set(["a", "a1", "a1a"]);
    const cloneIds: string[] = [];
    const walk = (n: MindMapModel) => {
      cloneIds.push(n.id);
      n.children.forEach(walk);
    };
    walk(clone);
    expect(cloneIds).toHaveLength(3);
    for (const id of cloneIds) expect(sourceIds.has(id)).toBe(false);
    // all clone ids are unique
    expect(new Set(cloneIds).size).toBe(3);
  });

  it("does not mutate the source node", () => {
    const node = findNode(sampleModel(), "a")!;
    const before = JSON.stringify(node);
    cloneWithNewIds(node);
    expect(JSON.stringify(node)).toBe(before);
  });
});

describe("visibleChildrenOf", () => {
  it("hides all children of a collapsed node, regardless of type", () => {
    const collapsedText: MindMapModel = { id: "c1", text: "C", collapsed: true, children: [{ id: "x", text: "X", children: [] }] };
    const collapsedObject: MindMapModel = {
      id: "c2",
      text: "C",
      type: "object",
      collapsed: true,
      children: [{ id: "y", text: "Y", children: [] }],
    };
    expect(visibleChildrenOf(collapsedText)).toEqual({ kind: "none" });
    expect(visibleChildrenOf(collapsedObject)).toEqual({ kind: "none" });
  });

  it("exposes an object node's direct children as leaves, not recursed into", () => {
    const grandchild: MindMapModel = { id: "gc", text: "GC", children: [] };
    const child: MindMapModel = { id: "c", text: "C", children: [grandchild] };
    const object: MindMapModel = { id: "o", text: "O", type: "object", children: [child] };
    expect(visibleChildrenOf(object)).toEqual({ kind: "leaves", children: [child] });
  });

  it("recurses normally into a non-collapsed, non-object node's children", () => {
    const model = sampleModel();
    expect(visibleChildrenOf(model)).toEqual({ kind: "recurse", children: model.children });
  });
});

describe("getNodeDepths", () => {
  it("assigns depth 0 to the root and increments per level", () => {
    const model = sampleModel();
    const depths = getNodeDepths(model);
    expect(depths.get("root")).toBe(0);
    expect(depths.get("a")).toBe(1);
    expect(depths.get("a1")).toBe(2);
    expect(depths.get("a1a")).toBe(3);
    expect(depths.get("b")).toBe(1);
  });

  it("covers every node in the tree", () => {
    const model = sampleModel();
    const depths = getNodeDepths(model);
    const order = getFlatOrder(model);
    for (const id of order) {
      expect(depths.has(id)).toBe(true);
    }
  });
});

describe("addSiblingAfter with root as target", () => {
  it("appends the new node as a child of root when root is the afterId", () => {
    const model = sampleModel();
    const newNode: MindMapModel = { id: "new", text: "New", children: [] };
    const result = addSiblingAfter(model, model.id, newNode);
    expect(result.children[result.children.length - 1].text).toBe("New");
  });
});

describe("splitNode at root", () => {
  it("unshifts a new child onto the root when the root is split", () => {
    const model: MindMapModel = {
      id: "root",
      text: "Hello",
      children: [{ id: "c1", text: "Child", children: [] }],
    };
    const { model: next, newNodeId } = splitNode(model, "root", 2);
    expect(next.text).toBe("He");
    const firstChild = next.children[0];
    expect(firstChild.id).toBe(newNodeId);
    expect(firstChild.text).toBe("llo");
  });

  it("is a no-op (returns early) when nodeId is not found", () => {
    const model = sampleModel();
    const { model: next, newNodeId } = splitNode(model, "missing", 0);
    expect(getFlatOrder(next)).toEqual(getFlatOrder(model));
    // Invariant: newNodeId must always exist in the returned model.
    expect(findNode(next, newNodeId)).not.toBeNull();
  });

  it("splitting at the start keeps the node's id/text/children and inserts an empty sibling before it", () => {
    const model: MindMapModel = {
      id: "root",
      text: "Root",
      children: [
        { id: "p", text: "Parent", children: [{ id: "c", text: "Child", children: [] }] },
      ],
    };
    const { model: next, newNodeId } = splitNode(model, "p", 0);
    // The original node is untouched (identity preserved).
    const p = findNode(next, "p")!;
    expect(p.text).toBe("Parent");
    expect(p.children.map((n) => n.id)).toEqual(["c"]);
    // The new node is the empty sibling inserted before it.
    expect(next.children.map((n) => n.id)).toEqual([newNodeId, "p"]);
    expect(findNode(next, newNodeId)!.text).toBe("");
  });
});

describe("mergeIntoPredecessor", () => {
  const tree = (): MindMapModel => ({
    id: "root",
    text: "Root",
    children: [
      { id: "a", text: "A", children: [{ id: "a1", text: "A1", children: [] }] },
      { id: "b", text: "B", children: [{ id: "b1", text: "B1", children: [] }] },
    ],
  });

  it("merges a node into its previous sibling, appending children", () => {
    const res = mergeIntoPredecessor(tree(), "b")!;
    expect(res.targetId).toBe("a");
    expect(res.caretPos).toBe(1); // length of "A" before the merge
    const a = findNode(res.model, "a")!;
    expect(a.text).toBe("AB");
    expect(a.children.map((c) => c.id)).toEqual(["a1", "b1"]);
    expect(findNode(res.model, "b")).toBeNull();
  });

  it("merges a first child into its parent, children taking the node's slot", () => {
    const res = mergeIntoPredecessor(tree(), "a1")!;
    expect(res.targetId).toBe("a");
    const a = findNode(res.model, "a")!;
    expect(a.text).toBe("AA1");
    expect(findNode(res.model, "a1")).toBeNull();
  });

  it("returns null for the root (no predecessor)", () => {
    expect(mergeIntoPredecessor(tree(), "root")).toBeNull();
  });

  it("returns null when the node is not found", () => {
    expect(mergeIntoPredecessor(tree(), "missing")).toBeNull();
  });
});

describe("mergeSuccessorInto", () => {
  const tree = (): MindMapModel => ({
    id: "root",
    text: "Root",
    children: [
      { id: "x", text: "X", children: [] },
      { id: "y", text: "Y", children: [{ id: "y1", text: "Y1", children: [] }] },
    ],
  });

  it("merges the first visible child up into the node", () => {
    const next = mergeSuccessorInto(tree(), "y");
    const y = findNode(next, "y")!;
    expect(y.text).toBe("YY1");
    expect(findNode(next, "y1")).toBeNull();
  });

  it("merges the next sibling when the node has no visible child", () => {
    const next = mergeSuccessorInto(tree(), "x");
    const x = findNode(next, "x")!;
    expect(x.text).toBe("XY");
    expect(x.children.map((c) => c.id)).toEqual(["y1"]);
    expect(findNode(next, "y")).toBeNull();
  });

  it("treats a collapsed node's children as hidden and merges the next sibling", () => {
    const model = tree();
    model.children[0] = {
      id: "x",
      text: "X",
      collapsed: true,
      children: [{ id: "xc", text: "XC", children: [] }],
    };
    const next = mergeSuccessorInto(model, "x");
    const x = findNode(next, "x")!;
    expect(x.text).toBe("XY"); // sibling Y merged, hidden child XC left in place
    expect(findNode(next, "xc")).not.toBeNull();
  });

  it("returns the same reference when there is no successor to merge", () => {
    const model = tree();
    expect(mergeSuccessorInto(model, "y1")).toBe(model); // leaf, last in subtree
  });

  it("returns the same reference when the node is not found", () => {
    const model = tree();
    expect(mergeSuccessorInto(model, "missing")).toBe(model);
  });
});

describe("addSiblingAfter edge cases", () => {
  it("returns model unchanged when afterId is not found", () => {
    const model = sampleModel();
    const newNode: MindMapModel = { id: "x", text: "X", children: [] };
    const result = addSiblingAfter(model, "nonexistent", newNode);
    expect(getFlatOrder(result)).toEqual(getFlatOrder(model));
  });
});

describe("updateNodeText edge cases", () => {
  it("returns model unchanged when nodeId is not found", () => {
    const model = sampleModel();
    const result = updateNodeText(model, "nonexistent", "new text");
    expect(findNode(result, "root")!.text).toBe("Root");
  });
});

describe("setNodeType", () => {
  it("sets type to 'link' on a node", () => {
    const model = sampleModel();
    const result = setNodeType(model, "b", "link");
    expect(findNode(result, "b")!.type).toBe("link");
  });

  it("stores 'text' type as absent (undefined)", () => {
    const model: MindMapModel = {
      id: "root",
      text: "Root",
      children: [{ id: "n", text: "Node", type: "link", children: [] }],
    };
    const result = setNodeType(model, "n", "text");
    expect(findNode(result, "n")!.type).toBeUndefined();
  });
});

describe("setNodeStyle branch conditions", () => {
  it("removes fontSize when null is passed", () => {
    const model: MindMapModel = {
      id: "root",
      text: "Root",
      children: [{ id: "n", text: "Node", fontSize: 20, children: [] }],
    };
    const result = setNodeStyle(model, "n", { fontSize: null });
    expect(findNode(result, "n")!.fontSize).toBeUndefined();
  });

  it("removes bold when false is passed", () => {
    const model: MindMapModel = {
      id: "root",
      text: "Root",
      children: [{ id: "n", text: "Node", bold: true, children: [] }],
    };
    const result = setNodeStyle(model, "n", { bold: false });
    expect(findNode(result, "n")!.bold).toBeUndefined();
  });
});

describe("setLinkMeta branch conditions", () => {
  it("removes linkTitle when empty string is passed", () => {
    const model: MindMapModel = {
      id: "root",
      text: "Root",
      children: [{ id: "n", text: "Node", linkTitle: "Old", children: [] }],
    };
    const result = setLinkMeta(model, "n", { linkTitle: "" });
    expect(findNode(result, "n")!.linkTitle).toBeUndefined();
  });

  it("removes favicon when null is passed", () => {
    const model: MindMapModel = {
      id: "root",
      text: "Root",
      children: [{ id: "n", text: "Node", favicon: "old.ico", children: [] }],
    };
    const result = setLinkMeta(model, "n", { favicon: null });
    expect(findNode(result, "n")!.favicon).toBeUndefined();
  });
});

describe("toggleCollapse edge cases", () => {
  it("is a no-op when nodeId is not found", () => {
    const model = sampleModel();
    const result = toggleCollapse(model, "nonexistent");
    expect(JSON.stringify(result)).toBe(JSON.stringify(model));
  });
});

describe("addChildToNode edge cases", () => {
  it("is a no-op when parentId is not found", () => {
    const model = sampleModel();
    const newNode: MindMapModel = { id: "x", text: "X", children: [] };
    const result = addChildToNode(model, "nonexistent", newNode);
    expect(getFlatOrder(result)).toEqual(getFlatOrder(model));
  });
});

describe("removeNode edge cases", () => {
  it("returns model unchanged when nodeId is the root", () => {
    const model = sampleModel();
    const result = removeNode(model, "root");
    expect(result.id).toBe("root");
  });

  it("returns model unchanged when nodeId is not found", () => {
    const model = sampleModel();
    const result = removeNode(model, "nonexistent");
    expect(getFlatOrder(result)).toEqual(getFlatOrder(model));
  });
});

describe("indentNode edge cases", () => {
  it("is a no-op when node is the root", () => {
    const model = sampleModel();
    const result = indentNode(model, "root");
    expect(getFlatOrder(result)).toEqual(getFlatOrder(model));
  });

  it("is a no-op when the node is the first child (index 0)", () => {
    const model = sampleModel();
    // "a" is the first child of root (index 0)
    const result = indentNode(model, "a");
    expect(getFlatOrder(result)).toEqual(getFlatOrder(model));
  });
});

describe("dedentNode edge cases", () => {
  it("is a no-op when node is the root", () => {
    const model = sampleModel();
    const result = dedentNode(model, "root");
    expect(getFlatOrder(result)).toEqual(getFlatOrder(model));
  });

  it("is a no-op when the node is a direct child of root (no grandparent)", () => {
    const model = sampleModel();
    const result = dedentNode(model, "a");
    expect(getFlatOrder(result)).toEqual(getFlatOrder(model));
  });

  it("is a no-op when nodeId is not found", () => {
    const model = sampleModel();
    const result = dedentNode(model, "nonexistent");
    expect(getFlatOrder(result)).toEqual(getFlatOrder(model));
  });
});

describe("moveNodeUp / moveNodeDown", () => {
  it("swaps a node with its next sibling (down)", () => {
    const model = sampleModel();
    const result = moveNodeDown(model, "a");
    expect(result.children.map((c) => c.id)).toEqual(["b", "a"]);
    // Subtree stays attached to the moved node.
    const a = findNode(result, "a")!;
    expect(a.children.map((c) => c.id)).toEqual(["a1"]);
  });

  it("swaps a node with its previous sibling (up)", () => {
    const model = sampleModel();
    const result = moveNodeUp(model, "b");
    expect(result.children.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("does not mutate the original model", () => {
    const model = sampleModel();
    moveNodeDown(model, "a");
    expect(model.children.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("returns the SAME reference when the node is already first (up)", () => {
    const model = sampleModel();
    expect(moveNodeUp(model, "a")).toBe(model);
  });

  it("returns the SAME reference when the node is already last (down)", () => {
    const model = sampleModel();
    expect(moveNodeDown(model, "b")).toBe(model);
  });

  it("returns the SAME reference for the root", () => {
    const model = sampleModel();
    expect(moveNodeUp(model, "root")).toBe(model);
    expect(moveNodeDown(model, "root")).toBe(model);
  });

  it("returns the SAME reference for an unknown node", () => {
    const model = sampleModel();
    expect(moveNodeUp(model, "nope")).toBe(model);
    expect(moveNodeDown(model, "nope")).toBe(model);
  });
});

describe("moveBranch", () => {
  /** Root / A(A1(A1a), A2) / B / C — three siblings, A with two children. */
  const wideModel = (): MindMapModel => ({
    id: "root",
    text: "Root",
    children: [
      {
        id: "a",
        text: "A",
        children: [
          {
            id: "a1",
            text: "A1",
            fontSize: 20,
            bold: true,
            children: [{ id: "a1a", text: "A1a", children: [] }],
          },
          { id: "a2", text: "A2", children: [] },
        ],
      },
      { id: "b", text: "B", children: [] },
      { id: "c", text: "C", children: [] },
    ],
  });

  it("moves a whole subtree to the end of a new parent (append)", () => {
    const result = moveBranch(wideModel(), "a1", "b");
    const b = findNode(result, "b")!;
    expect(b.children.map((n) => n.id)).toEqual(["a1"]);
    // The subtree travels with the node.
    expect(findNode(result, "a1")!.children.map((n) => n.id)).toEqual(["a1a"]);
    expect(findNode(result, "a")!.children.map((n) => n.id)).toEqual(["a2"]);
  });

  it("inserts at a given index under a new parent", () => {
    const result = moveBranch(wideModel(), "b", "a", 1);
    expect(findNode(result, "a")!.children.map((n) => n.id)).toEqual([
      "a1",
      "b",
      "a2",
    ]);
    expect(result.children.map((n) => n.id)).toEqual(["a", "c"]);
  });

  it("compensates the index on a same-parent forward move", () => {
    // [a,b,c]: moving a to index 2 (before c) must land [b,a,c], not [b,c,a].
    const result = moveBranch(wideModel(), "a", "root", 2);
    expect(result.children.map((n) => n.id)).toEqual(["b", "a", "c"]);
  });

  it("moves backward within the same parent without compensation", () => {
    const result = moveBranch(wideModel(), "c", "root", 0);
    expect(result.children.map((n) => n.id)).toEqual(["c", "a", "b"]);
  });

  it("preserves node attributes through a move", () => {
    const result = moveBranch(wideModel(), "a1", "c");
    const a1 = findNode(result, "a1")!;
    expect(a1.fontSize).toBe(20);
    expect(a1.bold).toBe(true);
  });

  it("does not mutate the original model", () => {
    const model = wideModel();
    moveBranch(model, "b", "a");
    expect(model.children.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(findNode(model, "a")!.children.map((n) => n.id)).toEqual([
      "a1",
      "a2",
    ]);
  });

  it("returns the SAME reference for the root", () => {
    const model = wideModel();
    expect(moveBranch(model, "root", "a")).toBe(model);
  });

  it("returns the SAME reference when dropping on itself", () => {
    const model = wideModel();
    expect(moveBranch(model, "a", "a")).toBe(model);
  });

  it("returns the SAME reference when dropping into its own descendant", () => {
    const model = wideModel();
    expect(moveBranch(model, "a", "a1a")).toBe(model);
  });

  it("returns the SAME reference for unknown ids", () => {
    const model = wideModel();
    expect(moveBranch(model, "nope", "a")).toBe(model);
    expect(moveBranch(model, "a", "nope")).toBe(model);
  });

  it("returns the SAME reference for a no-op append (already last child)", () => {
    const model = wideModel();
    expect(moveBranch(model, "c", "root")).toBe(model);
    expect(moveBranch(model, "a2", "a")).toBe(model);
  });

  it("returns the SAME reference for a no-op index (current slot)", () => {
    const model = wideModel();
    expect(moveBranch(model, "b", "root", 1)).toBe(model);
    expect(moveBranch(model, "b", "root", 2)).toBe(model);
  });
});

describe("null-node branch coverage for model mutations", () => {
  it("setNodeType is a no-op when nodeId is not found", () => {
    const model = sampleModel();
    const result = setNodeType(model, "nonexistent", "link");
    expect(JSON.stringify(result)).toBe(JSON.stringify(model));
  });

  it("setNodeStyle is a no-op when nodeId is not found", () => {
    const model = sampleModel();
    const result = setNodeStyle(model, "nonexistent", { fontSize: 20 });
    expect(JSON.stringify(result)).toBe(JSON.stringify(model));
  });

  it("setLinkMeta is a no-op when nodeId is not found", () => {
    const model = sampleModel();
    const result = setLinkMeta(model, "nonexistent", { linkTitle: "x" });
    expect(JSON.stringify(result)).toBe(JSON.stringify(model));
  });
});

describe("isStoredNodeType / isNumFormat", () => {
  // Every non-"text" NodeType member, spelled out so this test fails to
  // typecheck (not just fails at runtime) if a member is ever renamed without
  // updating the list below.
  const storedTypes: Exclude<NodeType, "text">[] = [
    "image",
    "link",
    "markdown",
    "object",
  ];
  const numFormats: NumFormat[] = ["comma", "currency", "percent"];

  it("accepts every declared StoredNodeType/NumFormat literal", () => {
    for (const t of storedTypes) expect(isStoredNodeType(t)).toBe(true);
    for (const f of numFormats) expect(isNumFormat(f)).toBe(true);
  });

  it("rejects text, unknown strings and non-strings", () => {
    for (const bad of ["text", "bogus", 1, null, undefined, {}]) {
      expect(isStoredNodeType(bad)).toBe(false);
      expect(isNumFormat(bad)).toBe(false);
    }
  });
});
