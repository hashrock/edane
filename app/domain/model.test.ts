import { describe, it, expect } from "vitest";
import type { MindMapModel } from "./model";
import { detachBranch, cloneWithNewIds, findNode, getFlatOrder } from "./model";

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
