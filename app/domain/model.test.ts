import { describe, it, expect } from "vitest";
import type { MindMapModel } from "./model";
import {
  detachBranch,
  cloneWithNewIds,
  findNode,
  getFlatOrder,
  getNodeDepths,
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
