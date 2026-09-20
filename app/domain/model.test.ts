import { describe, it, expect } from "vitest";
import type { MindMapDocument, MindMapModel, NodeType } from "./model";
import {
  detachBranch,
  findNode,
  findInTree,
  locateNode,
  isRoot,
  isMultiRoot,
  firstRootId,
  ensureRoot,
  setDocumentTitle,
  addRootAt,
  cloneDocument,
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
  nestUnder,
  subtreeIds,
  landOnPredecessor,
  hasStructuralSuccessor,
  isStoredNodeType,
} from "./model";

/** Wrap trees as a document (the title is not a node). */
function doc(roots: MindMapModel[], title = "Root"): MindMapDocument {
  return { title, roots };
}

/** Build a small fixed document with two trees:
 *  A
 *    A1
 *      A1a
 *  B
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

describe("findNode / findInTree / locateNode", () => {
  it("findNode searches every root; findInTree only one subtree", () => {
    const model = sampleModel();
    expect(findNode(model, "b")!.text).toBe("B");
    expect(findNode(model, "a1a")!.text).toBe("A1a");
    expect(findNode(model, "nope")).toBeNull();
    expect(findInTree(model.roots[0], "a1a")!.text).toBe("A1a");
    expect(findInTree(model.roots[0], "b")).toBeNull();
  });

  it("locateNode reports a root with parent null and the roots as its siblings", () => {
    const model = sampleModel();
    const loc = locateNode(model, "b")!;
    expect(loc.parent).toBeNull();
    expect(loc.siblings).toBe(model.roots);
    expect(loc.index).toBe(1);
  });

  it("locateNode reports a nested node's parent and slot", () => {
    const model = sampleModel();
    const loc = locateNode(model, "a1a")!;
    expect(loc.parent!.id).toBe("a1");
    expect(loc.siblings).toBe(loc.parent!.children);
    expect(loc.index).toBe(0);
    expect(locateNode(model, "nope")).toBeNull();
  });
});

describe("document helpers", () => {
  it("isRoot is true exactly for the roots", () => {
    const model = sampleModel();
    expect(isRoot(model, "a")).toBe(true);
    expect(isRoot(model, "b")).toBe(true);
    expect(isRoot(model, "a1")).toBe(false);
    expect(isRoot(model, "nope")).toBe(false);
  });

  it("firstRootId is the first root", () => {
    expect(firstRootId(sampleModel())).toBe("a");
  });

  it("ensureRoot returns the same reference when a root exists, else adds one blank root", () => {
    const model = sampleModel();
    expect(ensureRoot(model)).toBe(model);
    let n = 0;
    const repaired = ensureRoot(doc([]), () => `id${n++}`);
    expect(repaired.roots).toEqual([{ id: "id0", text: "", children: [] }]);
    expect(repaired.title).toBe("Root");
  });

  it("setDocumentTitle replaces the title and nothing else", () => {
    const model = sampleModel();
    const next = setDocumentTitle(model, "New");
    expect(next.title).toBe("New");
    expect(next.roots).toBe(model.roots);
    expect(model.title).toBe("Root");
  });

  it("isMultiRoot resolves absent to true and false to false", () => {
    expect(isMultiRoot(sampleModel())).toBe(true);
    expect(isMultiRoot({ ...sampleModel(), multiRoot: true })).toBe(true);
    expect(isMultiRoot({ ...sampleModel(), multiRoot: false })).toBe(false);
  });

  it("addRootAt appends a placed root without touching the original", () => {
    const model = sampleModel();
    const next = addRootAt(model, { id: "r", text: "", children: [] }, { x: 5, y: 6 });
    expect(next.roots.map((r) => r.id)).toEqual(["a", "b", "r"]);
    expect(next.roots[2].position).toEqual({ x: 5, y: 6 });
    expect(model.roots).toHaveLength(2);
  });

  it("cloneDocument is a deep copy", () => {
    const model = sampleModel();
    const copy = cloneDocument(model);
    expect(copy).toEqual(model);
    expect(copy.roots).not.toBe(model.roots);
    expect(copy.roots[0]).not.toBe(model.roots[0]);
  });

  it("subtreeIds lists the node first, then descendants in DFS order", () => {
    expect(subtreeIds(sampleModel().roots[0])).toEqual(["a", "a1", "a1a"]);
  });
});

describe("nestUnder", () => {
  it("expands the parent, drops the node's position and appends by default", () => {
    const parent: MindMapModel = { id: "p", text: "P", collapsed: true, children: [{ id: "c", text: "C", children: [] }] };
    const node: MindMapModel = { id: "n", text: "N", children: [], position: { x: 1, y: 2 } };
    nestUnder(parent, node);
    expect(parent.collapsed).toBe(false);
    expect(parent.children.map((c) => c.id)).toEqual(["c", "n"]);
    expect(node.position).toBeUndefined();
  });

  it("inserts at the given index", () => {
    const parent: MindMapModel = { id: "p", text: "P", children: [{ id: "c", text: "C", children: [] }] };
    nestUnder(parent, { id: "n", text: "N", children: [] }, 0);
    expect(parent.children.map((c) => c.id)).toEqual(["n", "c"]);
  });
});

describe("detachBranch", () => {
  it("detaches a root together with its subtree", () => {
    const model = sampleModel();
    const { doc: next, removed } = detachBranch(model, "a");
    expect(removed!.id).toBe("a");
    expect(removed!.children.map((c) => c.id)).toEqual(["a1"]);
    expect(next.roots.map((r) => r.id)).toEqual(["b"]);
  });

  it("detaching the last root leaves roots empty (ensureRoot repairs)", () => {
    const { doc: next } = detachBranch(doc([{ id: "only", text: "X", children: [] }]), "only");
    expect(next.roots).toEqual([]);
    expect(ensureRoot(next).roots).toHaveLength(1);
  });

  it("returns removed: null for an unknown node", () => {
    const model = sampleModel();
    const { removed } = detachBranch(model, "missing");
    expect(removed).toBeNull();
  });

  it("does not mutate the original document", () => {
    const model = sampleModel();
    const before = JSON.stringify(model);
    detachBranch(model, "a");
    expect(JSON.stringify(model)).toBe(before);
  });
});

describe("landOnPredecessor", () => {
  it("lands on the flat-order predecessor when it survives", () => {
    const model = sampleModel();
    const { doc: next } = detachBranch(model, "b");
    expect(landOnPredecessor(model, "b", next)).toBe("a1a");
  });

  it("falls back to the first root when there is no predecessor", () => {
    const model = sampleModel();
    const { doc: next } = detachBranch(model, "a");
    expect(landOnPredecessor(model, "a", next)).toBe("b");
  });

  it("returns the node itself when the document was emptied", () => {
    const model = doc([{ id: "only", text: "X", children: [] }]);
    const { doc: next } = detachBranch(model, "only");
    expect(landOnPredecessor(model, "only", next)).toBe("only");
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
  it("walks every root in order, skipping collapsed descendants", () => {
    const model = sampleModel();
    expect(getFlatOrder(model)).toEqual(["a", "a1", "a1a", "b"]);
    expect(getFlatOrder(toggleCollapse(model, "a1", true))).toEqual(["a", "a1", "b"]);
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
    for (const id of getFlatOrder(model)) expect(depths.has(id)).toBe(true);
  });
});

describe("addSiblingAfter with a root as target", () => {
  it("appends the new node as the root's last child (a sibling would be a new tree)", () => {
    const model = sampleModel();
    const newNode: MindMapModel = { id: "new", text: "New", children: [] };
    const result = addSiblingAfter(model, "a", newNode);
    expect(result.roots.map((r) => r.id)).toEqual(["a", "b"]);
    const a = findNode(result, "a")!;
    expect(a.children[a.children.length - 1].text).toBe("New");
  });

  it("inserts after a nested node under the same parent", () => {
    const result = addSiblingAfter(sampleModel(), "a1", { id: "new", text: "New", children: [] });
    expect(findNode(result, "a")!.children.map((c) => c.id)).toEqual(["a1", "new"]);
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
    expect(r.children[0].id).toBe(newNodeId);
    expect(r.children[0].text).toBe("llo");
    expect(next.roots).toHaveLength(1);
  });

  it("is a no-op (returns early) when nodeId is not found", () => {
    const model = sampleModel();
    const { doc: next, newNodeId } = splitNode(model, "missing", 0);
    expect(getFlatOrder(next)).toEqual(getFlatOrder(model));
    // Invariant: newNodeId must always exist in the returned document.
    expect(findNode(next, newNodeId)).not.toBeNull();
  });

  it("uses the supplied id source", () => {
    const { newNodeId } = splitNode(sampleModel(), "b", 1, () => "minted");
    expect(newNodeId).toBe("minted");
  });
});

describe("mergeIntoPredecessor", () => {
  const tree = (): MindMapDocument =>
    doc([
      { id: "a", text: "A", children: [{ id: "a1", text: "A1", children: [] }] },
      { id: "b", text: "B", children: [{ id: "b1", text: "B1", children: [] }] },
    ]);

  it("merges a later root into the previous root, appending children (joins the trees)", () => {
    const res = mergeIntoPredecessor(tree(), "b")!;
    expect(res.targetId).toBe("a");
    expect(res.caretPos).toBe(1); // length of "A" before the merge
    const a = findNode(res.doc, "a")!;
    expect(a.text).toBe("AB");
    expect(a.children.map((c) => c.id)).toEqual(["a1", "b1"]);
    expect(findNode(res.doc, "b")).toBeNull();
    expect(res.doc.roots.map((r) => r.id)).toEqual(["a"]);
  });

  it("merges a first child into its parent, children taking the node's slot", () => {
    const res = mergeIntoPredecessor(tree(), "a1")!;
    expect(res.targetId).toBe("a");
    const a = findNode(res.doc, "a")!;
    expect(a.text).toBe("AA1");
    expect(findNode(res.doc, "a1")).toBeNull();
  });

  it("returns null for the first root (no predecessor)", () => {
    expect(mergeIntoPredecessor(tree(), "a")).toBeNull();
  });

  it("returns null when the node is not found", () => {
    expect(mergeIntoPredecessor(tree(), "missing")).toBeNull();
  });

  it("expands a collapsed previous sibling so the merged-in children stay visible", () => {
    const model = doc([
      { id: "a", text: "A", collapsed: true, children: [{ id: "a1", text: "A1", children: [] }] },
      { id: "b", text: "B", children: [{ id: "b1", text: "B1", children: [] }] },
    ]);
    const res = mergeIntoPredecessor(model, "b")!;
    const a = findNode(res.doc, "a")!;
    expect(a.collapsed).toBe(false);
    expect(getFlatOrder(res.doc)).toEqual(["a", "a1", "b1"]);
  });
});

describe("mergeSuccessorInto / hasStructuralSuccessor", () => {
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

  it("merges the next root when a root has no visible child (joins the trees)", () => {
    const next = mergeSuccessorInto(tree(), "x");
    const x = findNode(next, "x")!;
    expect(x.text).toBe("XY");
    expect(x.children.map((c) => c.id)).toEqual(["y1"]);
    expect(findNode(next, "y")).toBeNull();
    expect(next.roots.map((r) => r.id)).toEqual(["x"]);
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

  it("returns the same reference when there is no successor or the node is not found", () => {
    const model = tree();
    expect(mergeSuccessorInto(model, "missing")).toBe(model);
    expect(mergeSuccessorInto(model, "y1")).toBe(model);
  });

  it("hasStructuralSuccessor agrees with the merge", () => {
    const model = tree();
    expect(hasStructuralSuccessor(model, "x")).toBe(true);
    expect(hasStructuralSuccessor(model, "y")).toBe(true);
    expect(hasStructuralSuccessor(model, "y1")).toBe(false);
    expect(hasStructuralSuccessor(model, "missing")).toBe(false);
  });
});

describe("addSiblingAfter edge cases", () => {
  it("returns the document unchanged when afterId is not found", () => {
    const model = sampleModel();
    const newNode: MindMapModel = { id: "x", text: "X", children: [] };
    const result = addSiblingAfter(model, "nonexistent", newNode);
    expect(getFlatOrder(result)).toEqual(getFlatOrder(model));
  });
});

describe("updateNodeText edge cases", () => {
  it("returns the document unchanged when nodeId is not found", () => {
    const model = sampleModel();
    const result = updateNodeText(model, "nonexistent", "new text");
    expect(result).toEqual(model);
  });

  it("updates a root's text", () => {
    expect(findNode(updateNodeText(sampleModel(), "a", "AA"), "a")!.text).toBe("AA");
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

describe("addChildToNode", () => {
  it("is a no-op when parentId is not found", () => {
    const model = sampleModel();
    const newNode: MindMapModel = { id: "x", text: "X", children: [] };
    const result = addChildToNode(model, "nonexistent", newNode);
    expect(getFlatOrder(result)).toEqual(getFlatOrder(model));
  });

  it("expands the parent and drops the child's canvas position (nestUnder)", () => {
    const model = doc([{ id: "p", text: "P", collapsed: true, children: [{ id: "c", text: "C", children: [] }] }]);
    const result = addChildToNode(model, "p", { id: "x", text: "X", children: [], position: { x: 1, y: 1 } });
    const p = findNode(result, "p")!;
    expect(p.collapsed).toBe(false);
    expect(p.children.map((c) => c.id)).toEqual(["c", "x"]);
    expect(findNode(result, "x")!.position).toBeUndefined();
  });
});

describe("removeNode", () => {
  it("removes a root and promotes its children to roots in its place", () => {
    const result = removeNode(sampleModel(), "a");
    expect(result.roots.map((r) => r.id)).toEqual(["a1", "b"]);
  });

  it("promotes a nested node's children to its parent", () => {
    const result = removeNode(sampleModel(), "a1");
    expect(findNode(result, "a")!.children.map((c) => c.id)).toEqual(["a1a"]);
  });

  it("returns the document unchanged when nodeId is not found", () => {
    const model = sampleModel();
    const result = removeNode(model, "nonexistent");
    expect(getFlatOrder(result)).toEqual(getFlatOrder(model));
  });
});

describe("indentNode", () => {
  it("is a no-op for the first root and for the first child", () => {
    const model = sampleModel();
    expect(getFlatOrder(indentNode(model, "a"))).toEqual(getFlatOrder(model));
    expect(getFlatOrder(indentNode(model, "a1"))).toEqual(getFlatOrder(model));
  });

  it("nests a later root under the previous root, dropping its position", () => {
    const model = sampleModel();
    model.roots[1].position = { x: 9, y: 9 };
    const result = indentNode(model, "b");
    expect(result.roots.map((r) => r.id)).toEqual(["a"]);
    expect(findNode(result, "a")!.children.map((c) => c.id)).toEqual(["a1", "b"]);
    expect(findNode(result, "b")!.position).toBeUndefined();
  });
});

describe("dedentNode", () => {
  it("is a no-op when the node is a root", () => {
    const model = sampleModel();
    const result = dedentNode(model, "a");
    expect(getFlatOrder(result)).toEqual(getFlatOrder(model));
  });

  it("makes a root's child a new root right after its parent (an explicit way to create a tree)", () => {
    const result = dedentNode(sampleModel(), "a1");
    expect(result.roots.map((r) => r.id)).toEqual(["a", "a1", "b"]);
    expect(findNode(result, "a")!.children).toEqual([]);
    expect(findNode(result, "a1")!.children.map((c) => c.id)).toEqual(["a1a"]);
  });

  it("moves a deeper node after its parent", () => {
    const result = dedentNode(sampleModel(), "a1a");
    expect(findNode(result, "a")!.children.map((c) => c.id)).toEqual(["a1", "a1a"]);
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
    expect(result.roots.map((c) => c.id)).toEqual(["b", "a"]);
    // Subtree stays attached to the moved node.
    const a = findNode(result, "a")!;
    expect(a.children.map((c) => c.id)).toEqual(["a1"]);
  });

  it("swaps a root with the previous root (up)", () => {
    const model = sampleModel();
    const result = moveNodeUp(model, "b");
    expect(result.roots.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("reorders nested siblings too", () => {
    const model = doc([{ id: "p", text: "P", children: [{ id: "x", text: "X", children: [] }, { id: "y", text: "Y", children: [] }] }]);
    expect(findNode(moveNodeUp(model, "y"), "p")!.children.map((c) => c.id)).toEqual(["y", "x"]);
  });

  it("does not mutate the original document", () => {
    const model = sampleModel();
    moveNodeDown(model, "a");
    expect(model.roots.map((c) => c.id)).toEqual(["a", "b"]);
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
  /** One tree T / A(A1(A1a), A2) / B / C — three siblings under T, A with two children. */
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
  const childrenOf = (m: MindMapDocument, id: string) => findNode(m, id)!.children.map((n) => n.id);

  it("moves a whole subtree to the end of a new parent (append)", () => {
    const result = moveBranch(wideModel(), "a1", "b");
    expect(childrenOf(result, "b")).toEqual(["a1"]);
    // The subtree travels with the node.
    expect(childrenOf(result, "a1")).toEqual(["a1a"]);
    expect(childrenOf(result, "a")).toEqual(["a2"]);
  });

  it("inserts at a given index under a new parent", () => {
    const result = moveBranch(wideModel(), "b", "a", 1);
    expect(childrenOf(result, "a")).toEqual(["a1", "b", "a2"]);
    expect(childrenOf(result, "t")).toEqual(["a", "c"]);
  });

  it("compensates the index on a same-parent forward move", () => {
    // [a,b,c]: moving a to index 2 (before c) must land [b,a,c], not [b,c,a].
    const result = moveBranch(wideModel(), "a", "t", 2);
    expect(childrenOf(result, "t")).toEqual(["b", "a", "c"]);
  });

  it("moves backward within the same parent without compensation", () => {
    const result = moveBranch(wideModel(), "c", "t", 0);
    expect(childrenOf(result, "t")).toEqual(["c", "a", "b"]);
  });

  it("preserves node attributes through a move", () => {
    const result = moveBranch(wideModel(), "a1", "c");
    const a1 = findNode(result, "a1")!;
    expect(a1.fontSize).toBe(20);
    expect(a1.bold).toBe(true);
  });

  it("nests a root under a node of another tree, dropping its canvas position", () => {
    const model = sampleModel();
    model.roots[1].position = { x: 3, y: 4 };
    const result = moveBranch(model, "b", "a1");
    expect(result.roots.map((r) => r.id)).toEqual(["a"]);
    expect(childrenOf(result, "a1")).toEqual(["a1a", "b"]);
    expect(findNode(result, "b")!.position).toBeUndefined();
  });

  it("expands a collapsed destination so the moved node stays visible", () => {
    const model = toggleCollapse(wideModel(), "a", true);
    const result = moveBranch(model, "b", "a");
    expect(findNode(result, "a")!.collapsed).toBe(false);
    expect(getFlatOrder(result)).toContain("b");
  });

  it("does not mutate the original document", () => {
    const model = wideModel();
    moveBranch(model, "b", "a");
    expect(childrenOf(model, "t")).toEqual(["a", "b", "c"]);
    expect(childrenOf(model, "a")).toEqual(["a1", "a2"]);
  });

  it("returns the SAME reference for a move onto itself or into its own subtree", () => {
    const model = wideModel();
    expect(moveBranch(model, "a", "a")).toBe(model);
    expect(moveBranch(model, "a", "a1a")).toBe(model);
    expect(moveBranch(model, "t", "b")).toBe(model);
  });

  it("returns the SAME reference for unknown ids", () => {
    const model = wideModel();
    expect(moveBranch(model, "nope", "a")).toBe(model);
    expect(moveBranch(model, "a", "nope")).toBe(model);
  });

  it("returns the SAME reference for a no-op position", () => {
    const model = wideModel();
    expect(moveBranch(model, "c", "t")).toBe(model);
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
    doc([{ id: "a", text: "A", children: [{ id: "a1", text: "A1", children: [] }] }]);

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

  it("does not mutate the input document", () => {
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
      { id: "a", text: "A", children: [{ id: "a1", text: "A1", children: [] }] },
      { id: "b", text: "B", children: [] },
    ]);

  it("gives a root the position and leaves the trees as they are", () => {
    const out = placeBranchAt(model(), "b", { x: 10, y: 20 });
    expect(out.roots.map((r) => r.id)).toEqual(["a", "b"]);
    expect(findNode(out, "b")!.position).toEqual({ x: 10, y: 20 });
  });

  it("detaches a nested node and makes it a new placed root", () => {
    const out = placeBranchAt(model(), "a1", { x: 10, y: 20 });
    expect(out.roots.map((r) => r.id)).toEqual(["a", "b", "a1"]);
    expect(findNode(out, "a")!.children).toEqual([]);
    expect(findNode(out, "a1")!.position).toEqual({ x: 10, y: 20 });
  });

  it("is a no-op (same reference) for unknown nodes", () => {
    const m = model();
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
