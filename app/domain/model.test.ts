import { describe, it, expect } from "vitest";
import type { MindMapModel, NodeType } from "./model";
import {
  detachBranch,
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
  setChecked,
  nextCheckedState,
  toggleCollapse,
  addChildToNode,
  removeNode,
  indentNode,
  dedentNode,
  moveNodeUp,
  moveNodeDown,
  moveBranch,
  placeBranchAt,
  mergeIntoPredecessor,
  mergeSuccessorInto,
  isStoredNodeType,
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

describe("visibleChildrenOf", () => {
  it("hides all children of a collapsed node", () => {
    const collapsedText: MindMapModel = { id: "c1", text: "C", collapsed: true, children: [{ id: "x", text: "X", children: [] }] };
    expect(visibleChildrenOf(collapsedText)).toEqual({ kind: "none" });
  });

  it("recurses normally into a non-collapsed node's children", () => {
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

  it("expands a collapsed previous sibling so the merged-in children stay visible", () => {
    const model: MindMapModel = {
      id: "root",
      text: "Root",
      children: [
        {
          id: "a",
          text: "A",
          collapsed: true,
          children: [{ id: "a1", text: "A1", children: [] }],
        },
        {
          id: "b",
          text: "B",
          children: [{ id: "b1", text: "B1", children: [] }],
        },
      ],
    };
    const res = mergeIntoPredecessor(model, "b")!;
    const a = findNode(res.model, "a")!;
    expect(a.collapsed).toBe(false);
    expect(getFlatOrder(res.model)).toEqual(["a", "a1", "b1"]);
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

  it("returns the SAME reference for unknown ids", () => {
    const model = wideModel();
    expect(moveBranch(model, "nope", "a")).toBe(model);
    expect(moveBranch(model, "a", "nope")).toBe(model);
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

describe("isStoredNodeType", () => {
  // Every non-"text" NodeType member, spelled out so this test fails to
  // typecheck (not just fails at runtime) if a member is ever renamed without
  // updating the list below.
  const storedTypes: Exclude<NodeType, "text">[] = [
    "image",
    "link",
    "markdown",
  ];

  it("accepts every declared StoredNodeType literal", () => {
    for (const t of storedTypes) expect(isStoredNodeType(t)).toBe(true);
  });

  it("rejects text, unknown strings and non-strings", () => {
    for (const bad of ["text", "bogus", 1, null, undefined, {}]) {
      expect(isStoredNodeType(bad)).toBe(false);
    }
  });
});

describe("task checkbox", () => {
  const tree = (): MindMapModel => ({
    id: "root",
    text: "R",
    children: [{ id: "a", text: "A", children: [{ id: "a1", text: "A1", children: [] }] }],
  });

  it("adds an open checkbox, then flips it done", () => {
    const open = setChecked(tree(), "a", false);
    expect(findNode(open, "a")!.checked).toBe(false);
    const done = setChecked(open, "a", true);
    expect(findNode(done, "a")!.checked).toBe(true);
  });

  it("removes the checkbox entirely on null (absent, not false)", () => {
    const cleared = setChecked(setChecked(tree(), "a", true), "a", null);
    expect(findNode(cleared, "a")!.checked).toBeUndefined();
    expect("checked" in findNode(cleared, "a")!).toBe(false);
  });

  it("leaves descendants alone — each node's checkbox is its own", () => {
    const done = setChecked(tree(), "a", true);
    expect(findNode(done, "a1")!.checked).toBeUndefined();
    expect(findNode(done, "root")!.checked).toBeUndefined();
  });

  it("does not mutate the input model", () => {
    const before = tree();
    setChecked(before, "a", true);
    expect(findNode(before, "a")!.checked).toBeUndefined();
  });

  it("cycles 未設定 → open → done → open, never back to 未設定", () => {
    expect(nextCheckedState(undefined)).toBe(false);
    expect(nextCheckedState(false)).toBe(true);
    expect(nextCheckedState(true)).toBe(false);
  });
});

describe("placeBranchAt", () => {
  const model = (): MindMapModel => ({
    id: "root",
    text: "Root",
    children: [
      {
        id: "a",
        text: "A",
        children: [{ id: "a1", text: "A1", children: [] }],
      },
      { id: "b", text: "B", children: [] },
    ],
  });

  it("is a no-op for the root and unknown nodes", () => {
    const m = model();
    expect(placeBranchAt(m, "root", { x: 0, y: 0 })).toBe(m);
    expect(placeBranchAt(m, "nope", { x: 0, y: 0 })).toBe(m);
  });
});

describe("isStoredNodeType against prototype names", () => {
  // `"constructor" in {...}` is true (inherited from Object.prototype), so a
  // crafted clipboard/API payload could smuggle in a "kind" that no
  // exhaustive switch on NodeType knows about. Found by the preferences
  // property test hitting the same idiom.
  it("rejects inherited property names", () => {
    for (const name of ["toString", "constructor", "hasOwnProperty", "__proto__", "valueOf"]) {
      expect(isStoredNodeType(name)).toBe(false);
    }
  });
});
