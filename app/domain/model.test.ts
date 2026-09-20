import { describe, it, expect } from "vitest";
import type { MindMapDocument, MindMapModel, NodeType } from "./model";
import {
  detachBranch,
  cloneWithNewIds,
  cloneDocument,
  findNode,
  findInTree,
  locateNode,
  isRoot,
  firstRootId,
  ensureRoot,
  setDocumentTitle,
  getFlatOrder,
  getNodeDepths,
  visibleChildrenOf,
  addSiblingAfter,
  addRootAt,
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

/** Wrap a forest as a document. */
function doc(roots: MindMapModel[], title = "Root"): MindMapDocument {
  return { title, roots };
}

/** Build a small fixed document (title "Root"):
 *    A
 *      A1
 *        A1a
 *    B
 */
function sampleModel(): MindMapDocument {
  return doc([
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
  ]);
}

const rootIds = (d: MindMapDocument) => d.roots.map((r) => r.id);

describe("findNode / findInTree / locateNode", () => {
  it("findNode searches every root", () => {
    const model = sampleModel();
    expect(findNode(model, "a1a")!.text).toBe("A1a");
    expect(findNode(model, "b")!.text).toBe("B");
    expect(findNode(model, "nope")).toBeNull();
  });

  it("findInTree searches only one subtree (the node included)", () => {
    const a = sampleModel().roots[0];
    expect(findInTree(a, "a")!.id).toBe("a");
    expect(findInTree(a, "a1a")!.id).toBe("a1a");
    expect(findInTree(a, "b")).toBeNull();
  });

  it("locateNode reports parent null and siblings = roots for a root", () => {
    const model = sampleModel();
    const loc = locateNode(model, "b")!;
    expect(loc.parent).toBeNull();
    expect(loc.siblings).toBe(model.roots);
    expect(loc.index).toBe(1);
  });

  it("locateNode reports the parent and its children for a nested node", () => {
    const model = sampleModel();
    const loc = locateNode(model, "a1a")!;
    expect(loc.parent!.id).toBe("a1");
    expect(loc.siblings).toBe(loc.parent!.children);
    expect(loc.index).toBe(0);
    expect(locateNode(model, "nope")).toBeNull();
  });
});

describe("root helpers", () => {
  it("isRoot is true only for the roots", () => {
    const model = sampleModel();
    expect(isRoot(model, "a")).toBe(true);
    expect(isRoot(model, "b")).toBe(true);
    expect(isRoot(model, "a1")).toBe(false);
    expect(isRoot(model, "nope")).toBe(false);
  });

  it("firstRootId is the first root", () => {
    expect(firstRootId(sampleModel())).toBe("a");
  });

  it("ensureRoot returns the same reference when a root exists", () => {
    const model = sampleModel();
    expect(ensureRoot(model)).toBe(model);
  });

  it("ensureRoot adds one blank root to an empty document", () => {
    const empty = doc([]);
    const fixed = ensureRoot(empty);
    expect(fixed.roots).toHaveLength(1);
    expect(fixed.roots[0].text).toBe("");
    expect(fixed.title).toBe("Root");
    expect(empty.roots).toEqual([]); // input untouched
  });

  it("setDocumentTitle replaces the title without touching the roots", () => {
    const model = sampleModel();
    const next = setDocumentTitle(model, "New");
    expect(next.title).toBe("New");
    expect(next.roots).toBe(model.roots);
    expect(model.title).toBe("Root");
  });

  it("addRootAt appends a placed root", () => {
    const next = addRootAt(sampleModel(), { id: "c", text: "C", children: [] }, { x: 5, y: 6 });
    expect(rootIds(next)).toEqual(["a", "b", "c"]);
    expect(findNode(next, "c")!.position).toEqual({ x: 5, y: 6 });
  });

  it("cloneDocument deep-copies", () => {
    const model = sampleModel();
    const copy = cloneDocument(model);
    expect(copy).toEqual(model);
    expect(copy.roots).not.toBe(model.roots);
    expect(copy.roots[0]).not.toBe(model.roots[0]);
  });
});

describe("detachBranch", () => {
  it("removes a node together with all its descendants", () => {
    const model = sampleModel();
    const { doc: next } = detachBranch(model, "a");
    // "a" and its whole subtree are gone (children are NOT promoted)
    expect(findNode(next, "a")).toBeNull();
    expect(findNode(next, "a1")).toBeNull();
    expect(findNode(next, "a1a")).toBeNull();
    // siblings untouched
    expect(getFlatOrder(next)).toEqual(["b"]);
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

  it("can detach a root; detaching the last root leaves roots empty", () => {
    const model = doc([{ id: "only", text: "Only", children: [] }]);
    const { doc: next, removed } = detachBranch(model, "only");
    expect(removed!.id).toBe("only");
    expect(next.roots).toEqual([]);
    // Callers restore the invariant with ensureRoot.
    expect(ensureRoot(next).roots).toHaveLength(1);
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
  it("hides all children of a collapsed node", () => {
    const collapsedText: MindMapModel = { id: "c1", text: "C", collapsed: true, children: [{ id: "x", text: "X", children: [] }] };
    expect(visibleChildrenOf(collapsedText)).toEqual({ kind: "none" });
  });

  it("recurses normally into a non-collapsed node's children", () => {
    const a = sampleModel().roots[0];
    expect(visibleChildrenOf(a)).toEqual({ kind: "recurse", children: a.children });
  });
});

describe("getFlatOrder", () => {
  it("walks the roots in order, DFS, skipping collapsed descendants", () => {
    expect(getFlatOrder(sampleModel())).toEqual(["a", "a1", "a1a", "b"]);
    const collapsed = toggleCollapse(sampleModel(), "a1", true);
    expect(getFlatOrder(collapsed)).toEqual(["a", "a1", "b"]);
  });
});

describe("getNodeDepths", () => {
  it("assigns depth 0 to every root and increments per level", () => {
    const model = sampleModel();
    const depths = getNodeDepths(model);
    expect(depths.get("a")).toBe(0);
    expect(depths.get("a1")).toBe(1);
    expect(depths.get("a1a")).toBe(2);
    expect(depths.get("b")).toBe(0);
  });

  it("covers every node in the document", () => {
    const model = sampleModel();
    const depths = getNodeDepths(model);
    const order = getFlatOrder(model);
    for (const id of order) {
      expect(depths.has(id)).toBe(true);
    }
  });
});

describe("addSiblingAfter with a root as target", () => {
  it("appends the new node as a child of the root instead of a new tree", () => {
    const model = sampleModel();
    const newNode: MindMapModel = { id: "new", text: "New", children: [] };
    const result = addSiblingAfter(model, "b", newNode);
    expect(rootIds(result)).toEqual(["a", "b"]);
    const b = findNode(result, "b")!;
    expect(b.children[b.children.length - 1].text).toBe("New");
  });

  it("inserts after a nested node among its siblings", () => {
    const newNode: MindMapModel = { id: "new", text: "New", children: [] };
    const result = addSiblingAfter(sampleModel(), "a1a", newNode);
    expect(findNode(result, "a1")!.children.map((c) => c.id)).toEqual(["a1a", "new"]);
  });
});

describe("splitNode at a root", () => {
  it("unshifts a new child onto the root when the root is split", () => {
    const model = doc([
      { id: "r", text: "Hello", children: [{ id: "c1", text: "Child", children: [] }] },
    ]);
    const { doc: next, newNodeId } = splitNode(model, "r", 2);
    const r = findNode(next, "r")!;
    expect(r.text).toBe("He");
    expect(rootIds(next)).toEqual(["r"]);
    const firstChild = r.children[0];
    expect(firstChild.id).toBe(newNodeId);
    expect(firstChild.text).toBe("llo");
  });

  it("is a no-op (returns early) when nodeId is not found", () => {
    const model = sampleModel();
    const { doc: next, newNodeId } = splitNode(model, "missing", 0);
    expect(getFlatOrder(next)).toEqual(getFlatOrder(model));
    // Invariant: newNodeId must always exist in the returned document.
    expect(findNode(next, newNodeId)).not.toBeNull();
  });

  it("splitting at the start keeps the node's id/text/children and inserts an empty sibling before it", () => {
    const model = doc([
      {
        id: "top",
        text: "Top",
        children: [
          { id: "p", text: "Parent", children: [{ id: "c", text: "Child", children: [] }] },
        ],
      },
    ]);
    const { doc: next, newNodeId } = splitNode(model, "p", 0);
    // The original node is untouched (identity preserved).
    const p = findNode(next, "p")!;
    expect(p.text).toBe("Parent");
    expect(p.children.map((n) => n.id)).toEqual(["c"]);
    // The new node is the empty sibling inserted before it.
    expect(findNode(next, "top")!.children.map((n) => n.id)).toEqual([newNodeId, "p"]);
    expect(findNode(next, newNodeId)!.text).toBe("");
  });

  it("splitting a root at the start prepends an empty child (no sibling tree)", () => {
    const model = doc([
      { id: "p", text: "Parent", children: [{ id: "c", text: "Child", children: [] }] },
    ]);
    const { doc: next, newNodeId } = splitNode(model, "p", 0);
    expect(rootIds(next)).toEqual(["p"]);
    expect(findNode(next, "p")!.children.map((n) => n.id)).toEqual([newNodeId, "c"]);
  });
});

describe("mergeIntoPredecessor", () => {
  const tree = (): MindMapDocument =>
    doc([
      {
        id: "top",
        text: "Top",
        children: [
          { id: "a", text: "A", children: [{ id: "a1", text: "A1", children: [] }] },
          { id: "b", text: "B", children: [{ id: "b1", text: "B1", children: [] }] },
        ],
      },
    ]);

  it("merges a node into its previous sibling, appending children", () => {
    const res = mergeIntoPredecessor(tree(), "b")!;
    expect(res.targetId).toBe("a");
    expect(res.caretPos).toBe(1); // length of "A" before the merge
    const a = findNode(res.doc, "a")!;
    expect(a.text).toBe("AB");
    expect(a.children.map((c) => c.id)).toEqual(["a1", "b1"]);
    expect(findNode(res.doc, "b")).toBeNull();
  });

  it("merges a first child into its parent, children taking the node's slot", () => {
    const res = mergeIntoPredecessor(tree(), "a1")!;
    expect(res.targetId).toBe("a");
    const a = findNode(res.doc, "a")!;
    expect(a.text).toBe("AA1");
    expect(findNode(res.doc, "a1")).toBeNull();
  });

  it("returns null for the first root (no predecessor)", () => {
    expect(mergeIntoPredecessor(tree(), "top")).toBeNull();
  });

  it("merges a later root into the previous root (joining the trees)", () => {
    const model = doc([
      { id: "r1", text: "R1", children: [{ id: "x", text: "X", children: [] }] },
      { id: "r2", text: "R2", children: [{ id: "y", text: "Y", children: [] }] },
    ]);
    const res = mergeIntoPredecessor(model, "r2")!;
    expect(res.targetId).toBe("r1");
    expect(res.caretPos).toBe(2);
    expect(rootIds(res.doc)).toEqual(["r1"]);
    const r1 = findNode(res.doc, "r1")!;
    expect(r1.text).toBe("R1R2");
    expect(r1.children.map((c) => c.id)).toEqual(["x", "y"]);
  });

  it("returns null when the node is not found", () => {
    expect(mergeIntoPredecessor(tree(), "missing")).toBeNull();
  });

  it("expands a collapsed previous sibling so the merged-in children stay visible", () => {
    const model = doc([
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
    ]);
    const res = mergeIntoPredecessor(model, "b")!;
    const a = findNode(res.doc, "a")!;
    expect(a.collapsed).toBe(false);
    expect(getFlatOrder(res.doc)).toEqual(["a", "a1", "b1"]);
  });
});

describe("mergeSuccessorInto", () => {
  const tree = (): MindMapDocument =>
    doc([
      { id: "x", text: "X", children: [] },
      { id: "y", text: "Y", children: [{ id: "y1", text: "Y1", children: [] }] },
    ]);

  it("merges the first visible child up into the node", () => {
    const next = mergeSuccessorInto(tree(), "y");
    const y = findNode(next, "y")!;
    expect(y.text).toBe("YY1");
    expect(findNode(next, "y1")).toBeNull();
  });

  it("merges the next sibling when the node has no visible child (next root for a root)", () => {
    const next = mergeSuccessorInto(tree(), "x");
    const x = findNode(next, "x")!;
    expect(x.text).toBe("XY");
    expect(x.children.map((c) => c.id)).toEqual(["y1"]);
    expect(findNode(next, "y")).toBeNull();
    expect(rootIds(next)).toEqual(["x"]);
  });

  it("treats a collapsed node's children as hidden and merges the next sibling", () => {
    const model = tree();
    model.roots[0] = {
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
    expect(result).toEqual(model);
  });

  it("updates a root's text", () => {
    const result = updateNodeText(sampleModel(), "a", "AA");
    expect(findNode(result, "a")!.text).toBe("AA");
  });
});

describe("setNodeType", () => {
  it("sets type to 'link' on a node", () => {
    const model = sampleModel();
    const result = setNodeType(model, "b", "link");
    expect(findNode(result, "b")!.type).toBe("link");
  });

  it("stores 'text' type as absent (undefined)", () => {
    const model = doc([{ id: "n", text: "Node", type: "link", children: [] }]);
    const result = setNodeType(model, "n", "text");
    expect(findNode(result, "n")!.type).toBeUndefined();
  });
});

describe("setNodeStyle branch conditions", () => {
  it("removes fontSize when null is passed", () => {
    const model = doc([{ id: "n", text: "Node", fontSize: 20, children: [] }]);
    const result = setNodeStyle(model, "n", { fontSize: null });
    expect(findNode(result, "n")!.fontSize).toBeUndefined();
  });

  it("removes bold when false is passed", () => {
    const model = doc([{ id: "n", text: "Node", bold: true, children: [] }]);
    const result = setNodeStyle(model, "n", { bold: false });
    expect(findNode(result, "n")!.bold).toBeUndefined();
  });
});

describe("setLinkMeta branch conditions", () => {
  it("removes linkTitle when empty string is passed", () => {
    const model = doc([{ id: "n", text: "Node", linkTitle: "Old", children: [] }]);
    const result = setLinkMeta(model, "n", { linkTitle: "" });
    expect(findNode(result, "n")!.linkTitle).toBeUndefined();
  });

  it("removes favicon when null is passed", () => {
    const model = doc([{ id: "n", text: "Node", favicon: "old.ico", children: [] }]);
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

describe("removeNode", () => {
  it("promotes a root's children to roots in its place", () => {
    const model = sampleModel();
    const result = removeNode(model, "a");
    expect(rootIds(result)).toEqual(["a1", "b"]);
    expect(findNode(result, "a1a")).not.toBeNull();
  });

  it("promotes a nested node's children to its parent", () => {
    const result = removeNode(sampleModel(), "a1");
    expect(findNode(result, "a")!.children.map((c) => c.id)).toEqual(["a1a"]);
  });

  it("returns model unchanged when nodeId is not found", () => {
    const model = sampleModel();
    const result = removeNode(model, "nonexistent");
    expect(getFlatOrder(result)).toEqual(getFlatOrder(model));
  });
});

describe("indentNode edge cases", () => {
  it("is a no-op when the node is the first root", () => {
    const model = sampleModel();
    const result = indentNode(model, "a");
    expect(getFlatOrder(result)).toEqual(getFlatOrder(model));
  });

  it("nests a later root under the previous root and drops its position", () => {
    const placed = placeBranchAt(sampleModel(), "b", { x: 1, y: 2 });
    const result = indentNode(placed, "b");
    expect(rootIds(result)).toEqual(["a"]);
    const a = findNode(result, "a")!;
    expect(a.children.map((c) => c.id)).toEqual(["a1", "b"]);
    expect(findNode(result, "b")!.position).toBeUndefined();
  });

  it("is a no-op when the node is the first child (index 0)", () => {
    const model = sampleModel();
    const result = indentNode(model, "a1");
    expect(getFlatOrder(result)).toEqual(getFlatOrder(model));
  });

  it("expands a collapsed previous sibling so the indented node stays visible", () => {
    const model = doc([
      {
        id: "a",
        text: "A",
        collapsed: true,
        children: [{ id: "a1", text: "A1", children: [] }],
      },
      { id: "b", text: "B", children: [] },
    ]);
    const result = indentNode(model, "b");
    const a = findNode(result, "a")!;
    expect(a.collapsed).toBe(false);
    expect(getFlatOrder(result)).toEqual(["a", "a1", "b"]);
  });
});

describe("dedentNode", () => {
  it("is a no-op when the node is a root", () => {
    const model = sampleModel();
    const result = dedentNode(model, "a");
    expect(getFlatOrder(result)).toEqual(getFlatOrder(model));
    expect(rootIds(result)).toEqual(["a", "b"]);
  });

  it("makes a root's child a new root right after its parent", () => {
    const result = dedentNode(sampleModel(), "a1");
    expect(rootIds(result)).toEqual(["a", "a1", "b"]);
    expect(findNode(result, "a")!.children).toEqual([]);
    expect(findNode(result, "a1")!.children.map((c) => c.id)).toEqual(["a1a"]);
  });

  it("moves a deeper node to its parent's level, after the parent", () => {
    const result = dedentNode(sampleModel(), "a1a");
    expect(findNode(result, "a")!.children.map((c) => c.id)).toEqual(["a1", "a1a"]);
    expect(findNode(result, "a1")!.children).toEqual([]);
  });

  it("is a no-op when nodeId is not found", () => {
    const model = sampleModel();
    const result = dedentNode(model, "nonexistent");
    expect(getFlatOrder(result)).toEqual(getFlatOrder(model));
  });
});

describe("moveNodeUp / moveNodeDown", () => {
  it("swaps a root with the next root (down)", () => {
    const model = sampleModel();
    const result = moveNodeDown(model, "a");
    expect(rootIds(result)).toEqual(["b", "a"]);
    // Subtree stays attached to the moved node.
    const a = findNode(result, "a")!;
    expect(a.children.map((c) => c.id)).toEqual(["a1"]);
  });

  it("swaps a root with the previous root (up)", () => {
    const model = sampleModel();
    const result = moveNodeUp(model, "b");
    expect(rootIds(result)).toEqual(["b", "a"]);
  });

  it("swaps nested siblings", () => {
    const model = doc([
      {
        id: "p",
        text: "P",
        children: [
          { id: "c1", text: "1", children: [] },
          { id: "c2", text: "2", children: [] },
        ],
      },
    ]);
    expect(findNode(moveNodeDown(model, "c1"), "p")!.children.map((c) => c.id)).toEqual(["c2", "c1"]);
    expect(findNode(moveNodeUp(model, "c2"), "p")!.children.map((c) => c.id)).toEqual(["c2", "c1"]);
  });

  it("does not mutate the original model", () => {
    const model = sampleModel();
    moveNodeDown(model, "a");
    expect(rootIds(model)).toEqual(["a", "b"]);
  });

  it("returns the SAME reference when the node is already first (up)", () => {
    const model = sampleModel();
    expect(moveNodeUp(model, "a")).toBe(model);
  });

  it("returns the SAME reference when the node is already last (down)", () => {
    const model = sampleModel();
    expect(moveNodeDown(model, "b")).toBe(model);
  });

  it("returns the SAME reference for an unknown node", () => {
    const model = sampleModel();
    expect(moveNodeUp(model, "nope")).toBe(model);
    expect(moveNodeDown(model, "nope")).toBe(model);
  });
});

describe("moveBranch", () => {
  /** T( A(A1(A1a), A2), B, C ) — one root with three children, A with two. */
  const wideModel = (): MindMapDocument =>
    doc([
      {
        id: "t",
        text: "T",
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
      },
    ]);
  const tChildren = (d: MindMapDocument) => findNode(d, "t")!.children.map((n) => n.id);

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
    expect(tChildren(result)).toEqual(["a", "c"]);
  });

  it("compensates the index on a same-parent forward move", () => {
    // [a,b,c]: moving a to index 2 (before c) must land [b,a,c], not [b,c,a].
    const result = moveBranch(wideModel(), "a", "t", 2);
    expect(tChildren(result)).toEqual(["b", "a", "c"]);
  });

  it("moves backward within the same parent without compensation", () => {
    const result = moveBranch(wideModel(), "c", "t", 0);
    expect(tChildren(result)).toEqual(["c", "a", "b"]);
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
    expect(tChildren(model)).toEqual(["a", "b", "c"]);
    expect(findNode(model, "a")!.children.map((n) => n.id)).toEqual([
      "a1",
      "a2",
    ]);
  });

  it("nests a root under a node of another tree (it stops being a tree)", () => {
    const model = doc([
      { id: "r1", text: "R1", children: [] },
      { id: "r2", text: "R2", position: { x: 1, y: 1 }, children: [] },
    ]);
    const result = moveBranch(model, "r2", "r1");
    expect(rootIds(result)).toEqual(["r1"]);
    expect(findNode(result, "r1")!.children.map((n) => n.id)).toEqual(["r2"]);
    expect(findNode(result, "r2")!.position).toBeUndefined();
  });

  it("returns the SAME reference when dropping on itself", () => {
    const model = wideModel();
    expect(moveBranch(model, "a", "a")).toBe(model);
  });

  it("returns the SAME reference when dropping into its own descendant", () => {
    const model = wideModel();
    expect(moveBranch(model, "a", "a1a")).toBe(model);
    expect(moveBranch(model, "t", "a")).toBe(model);
  });

  it("returns the SAME reference for unknown ids", () => {
    const model = wideModel();
    expect(moveBranch(model, "nope", "a")).toBe(model);
    expect(moveBranch(model, "a", "nope")).toBe(model);
  });

  it("returns the SAME reference for a no-op append (already last child)", () => {
    const model = wideModel();
    expect(moveBranch(model, "c", "t")).toBe(model);
    expect(moveBranch(model, "a2", "a")).toBe(model);
  });

  it("returns the SAME reference for a no-op index (current slot)", () => {
    const model = wideModel();
    expect(moveBranch(model, "b", "t", 1)).toBe(model);
    expect(moveBranch(model, "b", "t", 2)).toBe(model);
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
  const tree = (): MindMapDocument =>
    doc([{ id: "a", text: "A", children: [{ id: "a1", text: "A1", children: [] }] }], "R");

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
  const model = (): MindMapDocument =>
    doc([
      {
        id: "a",
        text: "A",
        children: [{ id: "a1", text: "A1", children: [] }],
      },
      { id: "b", text: "B", children: [] },
    ]);

  it("sets the position of a root in place", () => {
    const next = placeBranchAt(model(), "b", { x: 500, y: 120 });
    expect(rootIds(next)).toEqual(["a", "b"]);
    expect(findNode(next, "b")!.position).toEqual({ x: 500, y: 120 });
  });

  it("detaches a nested node and makes it a new root there", () => {
    const next = placeBranchAt(model(), "a1", { x: 40, y: 800 });
    expect(rootIds(next)).toEqual(["a", "b", "a1"]);
    expect(findNode(next, "a")!.children).toEqual([]);
    expect(findNode(next, "a1")!.position).toEqual({ x: 40, y: 800 });
  });

  it("is a no-op for unknown nodes", () => {
    const m = model();
    expect(placeBranchAt(m, "nope", { x: 0, y: 0 })).toBe(m);
  });

  it("moveBranch drops the position once the tree is nested again", () => {
    const placed = placeBranchAt(model(), "b", { x: 500, y: 120 });
    const nested = moveBranch(placed, "b", "a");
    expect(findNode(nested, "b")!.position).toBeUndefined();
    // Reordering among the roots keeps it.
    const reordered = moveNodeUp(placed, "b");
    expect(rootIds(reordered)).toEqual(["b", "a"]);
    expect(findNode(reordered, "b")!.position).toEqual({ x: 500, y: 120 });
  });
});
