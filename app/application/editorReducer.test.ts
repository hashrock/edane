import { describe, it, expect } from "vitest";
import type { MindMapModel } from "../domain/model";
import { getFlatOrder, findNode } from "../domain/model";
import { editorReducer, type EditorState } from "./editorReducer";

/** Strip IDs so we can compare tree structure and text only */
function stripIds(model: MindMapModel): unknown {
  return {
    text: model.text,
    children: model.children.map(stripIds),
  };
}

/** Build a small fixed tree:
 *  Root
 *    A
 *      A1
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
        children: [{ id: "a1", text: "A1", children: [] }],
      },
      { id: "b", text: "B", children: [] },
    ],
  };
}

/** Editor state focused on a given node at the end of its text */
function stateAt(model: MindMapModel, nodeId: string): EditorState {
  const node = findNode(model, nodeId)!;
  return {
    model,
    activeNodeId: nodeId,
    editing: true,
    editingText: node.text,
    cursorPos: node.text.length,
    selectionEnd: node.text.length,
    clipboard: null,
  };
}

describe("enter", () => {
  it("appends an empty sibling when cursor is at end", () => {
    const model = sampleModel();
    const next = editorReducer(stateAt(model, "a1"), {
      type: "enter",
      pos: 2,
    });
    // a1's parent is "a"; new empty node added after a1 under "a"
    const a = findNode(next.model, "a")!;
    expect(a.children.map((c) => c.text)).toEqual(["A1", ""]);
    expect(next.activeNodeId).not.toBe("a1");
    expect(next.editingText).toBe("");
    expect(next.cursorPos).toBe(0);
  });

  it("splits a node at the cursor", () => {
    const model = sampleModel();
    const s = stateAt(model, "a");
    const next = editorReducer({ ...s, cursorPos: 0, selectionEnd: 0 }, {
      type: "enter",
      pos: 0,
    });
    // Splitting "A" at pos 0 → empty node before "A" portion; new node holds "A"
    const root = findNode(next.model, "root")!;
    expect(root.children.map((c) => c.text)).toEqual(["", "A", "B"]);
  });

  it("is a no-op without an active node", () => {
    const model = sampleModel();
    const s: EditorState = { ...stateAt(model, "a"), activeNodeId: null };
    expect(editorReducer(s, { type: "enter", pos: 0 })).toBe(s);
  });
});

describe("tab / shift+tab", () => {
  it("indents a node under its previous sibling", () => {
    const model = sampleModel();
    const next = editorReducer(stateAt(model, "b"), {
      type: "tab",
      shift: false,
    });
    const a = findNode(next.model, "a")!;
    expect(a.children.map((c) => c.text)).toEqual(["A1", "B"]);
  });

  it("dedents a node to its grandparent level", () => {
    const model = sampleModel();
    const next = editorReducer(stateAt(model, "a1"), {
      type: "tab",
      shift: true,
    });
    const root = findNode(next.model, "root")!;
    expect(root.children.map((c) => c.text)).toEqual(["A", "A1", "B"]);
  });
});

describe("backspaceAtStart", () => {
  it("removes an empty node and moves to the previous node", () => {
    const model: MindMapModel = {
      id: "root",
      text: "Root",
      children: [
        { id: "a", text: "A", children: [] },
        { id: "empty", text: "", children: [] },
      ],
    };
    const next = editorReducer(stateAt(model, "empty"), {
      type: "backspaceAtStart",
    });
    expect(findNode(next.model, "empty")).toBeNull();
    expect(next.activeNodeId).toBe("a");
    expect(next.cursorPos).toBe(1);
  });

  it("merges a non-empty node into the previous node", () => {
    const model = sampleModel();
    // focus "b" at start, merge into previous node in DFS order ("a1")
    const s = { ...stateAt(model, "b"), cursorPos: 0, selectionEnd: 0 };
    const next = editorReducer(s, { type: "backspaceAtStart" });
    expect(findNode(next.model, "b")).toBeNull();
    const a1 = findNode(next.model, "a1")!;
    expect(a1.text).toBe("A1B");
    expect(next.activeNodeId).toBe("a1");
    expect(next.cursorPos).toBe(2);
  });

  it("does nothing at the root node", () => {
    const model = sampleModel();
    const s = { ...stateAt(model, "root"), cursorPos: 0, selectionEnd: 0 };
    expect(editorReducer(s, { type: "backspaceAtStart" })).toBe(s);
  });
});

describe("deleteAtEnd", () => {
  it("merges the next node into the current node", () => {
    const model = sampleModel();
    const s = stateAt(model, "a1"); // cursor at end of "A1"
    const next = editorReducer(s, { type: "deleteAtEnd", pos: 2 });
    // next node in DFS order after a1 is "b"
    expect(findNode(next.model, "b")).toBeNull();
    const a1 = findNode(next.model, "a1")!;
    expect(a1.text).toBe("A1B");
    expect(next.cursorPos).toBe(2);
  });
});

describe("navigation", () => {
  it("moveUp / moveDown walk DFS order", () => {
    const model = sampleModel();
    const order = getFlatOrder(model); // root, a, a1, b
    const down = editorReducer(stateAt(model, "a"), { type: "moveDown" });
    expect(down.activeNodeId).toBe(order[order.indexOf("a") + 1]);
    const up = editorReducer(stateAt(model, "a1"), { type: "moveUp" });
    expect(up.activeNodeId).toBe("a");
  });

  it("moveUp is a no-op at the first node", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    expect(editorReducer(s, { type: "moveUp" })).toBe(s);
  });
});

describe("branch clipboard (cut / copy / paste)", () => {
  // DFS order of sampleModel: root, a, a1, b
  it("copyBranch stores the subtree and leaves the model untouched", () => {
    const model = sampleModel();
    const next = editorReducer(stateAt(model, "a"), { type: "copyBranch" });
    expect(next.model).toBe(model); // model unchanged
    expect(next.clipboard).not.toBeNull();
    expect(next.clipboard!.text).toBe("A");
    expect(next.clipboard!.children[0].text).toBe("A1");
  });

  it("cutBranch removes the node with its descendants and stores them", () => {
    const model = sampleModel();
    const next = editorReducer(stateAt(model, "a"), { type: "cutBranch" });
    expect(getFlatOrder(next.model)).toEqual(["root", "b"]); // a + a1 gone
    expect(next.clipboard!.text).toBe("A");
    expect(next.clipboard!.children[0].text).toBe("A1");
  });

  it("cutBranch lands focus on the previous node in flat order", () => {
    const model = sampleModel();
    const next = editorReducer(stateAt(model, "b"), { type: "cutBranch" });
    // before "b" in DFS (root, a, a1, b) is "a1"
    expect(next.activeNodeId).toBe("a1");
  });

  it("cutBranch on the root is a no-op", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    expect(editorReducer(s, { type: "cutBranch" })).toBe(s);
  });

  it("pasteBranch inserts the clipboard as a child of the active node", () => {
    const model = sampleModel();
    const copied = editorReducer(stateAt(model, "a"), { type: "copyBranch" });
    // select "b", then paste
    const onB = { ...copied, activeNodeId: "b", editingText: "B" };
    const next = editorReducer(onB, { type: "pasteBranch" });
    const b = findNode(next.model, "b")!;
    expect(b.children).toHaveLength(1);
    expect(b.children[0].text).toBe("A");
    expect(b.children[0].children[0].text).toBe("A1");
    // focus moves to the pasted subtree root
    expect(next.activeNodeId).toBe(b.children[0].id);
  });

  it("pasteBranch assigns fresh ids (no clash with the source)", () => {
    const model = sampleModel();
    const copied = editorReducer(stateAt(model, "a"), { type: "copyBranch" });
    const onB = { ...copied, activeNodeId: "b", editingText: "B" };
    const next = editorReducer(onB, { type: "pasteBranch" });
    const pasted = findNode(next.model, "b")!.children[0];
    expect(pasted.id).not.toBe("a");
    expect(pasted.children[0].id).not.toBe("a1");
    // original "a" still present and untouched
    expect(findNode(next.model, "a")).not.toBeNull();
  });

  it("cut → select → paste moves a branch under a new parent", () => {
    const model = sampleModel();
    const cut = editorReducer(stateAt(model, "a"), { type: "cutBranch" });
    expect(findNode(cut.model, "a")).toBeNull();
    const onB = { ...cut, activeNodeId: "b", editingText: "B" };
    const moved = editorReducer(onB, { type: "pasteBranch" });
    const b = findNode(moved.model, "b")!;
    expect(b.children[0].text).toBe("A");
    expect(b.children[0].children[0].text).toBe("A1");
  });

  it("copy → paste twice yields two independent subtrees", () => {
    const model = sampleModel();
    const copied = editorReducer(stateAt(model, "a"), { type: "copyBranch" });
    const onB = { ...copied, activeNodeId: "b", editingText: "B" };
    const once = editorReducer(onB, { type: "pasteBranch" });
    const twice = editorReducer(
      { ...once, activeNodeId: "b" },
      { type: "pasteBranch" }
    );
    const b = findNode(twice.model, "b")!;
    expect(b.children).toHaveLength(2);
    expect(b.children[0].id).not.toBe(b.children[1].id);
    expect(b.children[0].text).toBe("A");
    expect(b.children[1].text).toBe("A");
  });

  it("pasteBranch is a no-op when the clipboard is empty", () => {
    const model = sampleModel();
    const s = stateAt(model, "b");
    expect(editorReducer(s, { type: "pasteBranch" })).toBe(s);
  });

  it("pasteBranch expands a collapsed target so the paste is visible", () => {
    const model = sampleModel();
    const copied = editorReducer(stateAt(model, "b"), { type: "copyBranch" });
    // collapse "a" then paste into it
    const collapsedA: MindMapModel = {
      ...model,
      children: model.children.map((c) =>
        c.id === "a" ? { ...c, collapsed: true } : c
      ),
    };
    const onA = {
      ...copied,
      model: collapsedA,
      activeNodeId: "a",
      editingText: "A",
    };
    const next = editorReducer(onA, { type: "pasteBranch" });
    expect(findNode(next.model, "a")!.collapsed).toBeFalsy();
  });
});

describe("typeText", () => {
  it("commits text to the model when commitModel is true", () => {
    const model = sampleModel();
    const next = editorReducer(stateAt(model, "a"), {
      type: "typeText",
      text: "Apple",
      cursorPos: 5,
      selectionEnd: 5,
      commitModel: true,
    });
    expect(findNode(next.model, "a")!.text).toBe("Apple");
    expect(next.editingText).toBe("Apple");
  });

  it("leaves the model untouched during IME composition", () => {
    const model = sampleModel();
    const next = editorReducer(stateAt(model, "a"), {
      type: "typeText",
      text: "あ",
      cursorPos: 1,
      selectionEnd: 1,
      commitModel: false,
    });
    expect(findNode(next.model, "a")!.text).toBe("A");
    expect(next.editingText).toBe("あ");
  });
});

describe("insertNodes", () => {
  it("inserts parsed nodes after the target and focuses the last one", () => {
    const model = sampleModel();
    const nodes: MindMapModel[] = [
      { id: "n1", text: "X", children: [] },
      { id: "n2", text: "Y", children: [] },
    ];
    const next = editorReducer(stateAt(model, "a"), {
      type: "insertNodes",
      targetId: "a",
      nodes,
    });
    const root = findNode(next.model, "root")!;
    expect(root.children.map((c) => c.text)).toEqual(["A", "X", "Y", "B"]);
    expect(next.activeNodeId).toBe("n2");
  });
});

describe("setTitle", () => {
  it("updates the root node text", () => {
    const model = sampleModel();
    const next = editorReducer(stateAt(model, "a"), {
      type: "setTitle",
      text: "New Title",
    });
    expect(next.model.text).toBe("New Title");
    expect(stripIds(next.model.children[0])).toEqual(
      stripIds(model.children[0])
    );
  });

  it("keeps the root editing buffer in sync when the root is active", () => {
    const model = sampleModel();
    const next = editorReducer(stateAt(model, "root"), {
      type: "setTitle",
      text: "New Title",
    });
    expect(next.model.text).toBe("New Title");
    expect(next.editingText).toBe("New Title");
  });

  it("clamps the root caret when the edited title gets shorter", () => {
    const model = sampleModel();
    const s = {
      ...stateAt(model, "root"),
      cursorPos: 4,
      selectionEnd: 4,
    };
    const next = editorReducer(s, {
      type: "setTitle",
      text: "R",
    });
    expect(next.cursorPos).toBe(1);
    expect(next.selectionEnd).toBe(1);
  });
});

describe("no-op convention", () => {
  it("returns the same reference for setSelection with identical values", () => {
    const model = sampleModel();
    const s = stateAt(model, "a");
    expect(
      editorReducer(s, {
        type: "setSelection",
        cursorPos: s.cursorPos,
        selectionEnd: s.selectionEnd,
      })
    ).toBe(s);
  });
});
