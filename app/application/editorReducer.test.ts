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

  it("returns a new state for setSelection with different values", () => {
    const model = sampleModel();
    const s = stateAt(model, "a");
    const next = editorReducer(s, {
      type: "setSelection",
      cursorPos: 0,
      selectionEnd: 1,
    });
    expect(next).not.toBe(s);
    expect(next.cursorPos).toBe(0);
    expect(next.selectionEnd).toBe(1);
  });

  it("deleteAtEnd is a no-op when cursor is not at end", () => {
    const model = sampleModel();
    const s = { ...stateAt(model, "a1"), cursorPos: 1, selectionEnd: 1 };
    expect(editorReducer(s, { type: "deleteAtEnd", pos: 1 })).toBe(s);
  });

  it("deleteAtEnd is a no-op at the last node", () => {
    const model = sampleModel();
    const s = stateAt(model, "b");
    expect(editorReducer(s, { type: "deleteAtEnd", pos: 1 })).toBe(s);
  });

  it("moveDown is a no-op at the last node", () => {
    const model = sampleModel();
    const s = stateAt(model, "b");
    expect(editorReducer(s, { type: "moveDown" })).toBe(s);
  });
});

describe("cmdLeft / cmdRight", () => {
  it("cmdLeft at pos 0 jumps to end of previous node", () => {
    const model = sampleModel();
    const s = { ...stateAt(model, "b"), cursorPos: 0, selectionEnd: 0 };
    const next = editorReducer(s, { type: "cmdLeft", pos: 0 });
    expect(next.activeNodeId).toBe("a1");
    expect(next.cursorPos).toBe(2);
  });

  it("cmdLeft not at start jumps cursor to start of current node", () => {
    const model = sampleModel();
    const s = { ...stateAt(model, "a"), cursorPos: 1, selectionEnd: 1 };
    const next = editorReducer(s, { type: "cmdLeft", pos: 1 });
    expect(next.activeNodeId).toBe("a");
    expect(next.cursorPos).toBe(0);
    expect(next.selectionEnd).toBe(0);
  });

  it("cmdLeft is a no-op when already at start of first node", () => {
    const model = sampleModel();
    // root is idx=0, so pos=0 does not jump to a previous node
    const s = { ...stateAt(model, "root"), cursorPos: 0, selectionEnd: 0 };
    expect(editorReducer(s, { type: "cmdLeft", pos: 0 })).toBe(s);
  });

  it("cmdRight at end jumps to start of next node", () => {
    const model = sampleModel();
    const s = stateAt(model, "a1"); // cursor at end of "A1"
    const next = editorReducer(s, { type: "cmdRight", pos: 2 });
    expect(next.activeNodeId).toBe("b");
    expect(next.cursorPos).toBe(0);
    expect(next.selectionEnd).toBe(0);
  });

  it("cmdRight not at end jumps cursor to end of current node", () => {
    const model = sampleModel();
    const s = { ...stateAt(model, "a"), cursorPos: 0, selectionEnd: 0 };
    const next = editorReducer(s, { type: "cmdRight", pos: 0 });
    expect(next.activeNodeId).toBe("a");
    expect(next.cursorPos).toBe(1);
    expect(next.selectionEnd).toBe(1);
  });

  it("cmdRight is a no-op when already at end of node", () => {
    const model = sampleModel();
    const s = stateAt(model, "b"); // cursor at end of "B"
    expect(editorReducer(s, { type: "cmdRight", pos: 1 })).toBe(s);
  });
});

describe("cmdShiftLeft / cmdShiftRight", () => {
  it("cmdShiftLeft extends selection to start of node", () => {
    const model = sampleModel();
    const s = { ...stateAt(model, "a"), cursorPos: 0, selectionEnd: 1 };
    const next = editorReducer(s, {
      type: "cmdShiftLeft",
      pos: 0,
      selEnd: 1,
    });
    expect(next.cursorPos).toBe(0);
    expect(next.selectionEnd).toBe(1);
  });

  it("cmdShiftRight extends selection to end of node", () => {
    const model = sampleModel();
    const s = { ...stateAt(model, "a1"), cursorPos: 0, selectionEnd: 0 };
    const next = editorReducer(s, {
      type: "cmdShiftRight",
      pos: 0,
      selEnd: 2,
    });
    expect(next.cursorPos).toBe(0);
    expect(next.selectionEnd).toBe(2);
  });
});

describe("arrowLeftEdge / arrowRightEdge", () => {
  it("arrowLeftEdge moves focus to previous node", () => {
    const model = sampleModel();
    const s = stateAt(model, "b");
    const next = editorReducer(s, { type: "arrowLeftEdge" });
    expect(next.activeNodeId).toBe("a1");
  });

  it("arrowLeftEdge is a no-op at the first node", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    expect(editorReducer(s, { type: "arrowLeftEdge" })).toBe(s);
  });

  it("arrowRightEdge moves focus to next node", () => {
    const model = sampleModel();
    const s = stateAt(model, "a1");
    const next = editorReducer(s, { type: "arrowRightEdge" });
    expect(next.activeNodeId).toBe("b");
    expect(next.cursorPos).toBe(0);
    expect(next.selectionEnd).toBe(0);
  });

  it("arrowRightEdge is a no-op at the last node", () => {
    const model = sampleModel();
    const s = stateAt(model, "b");
    expect(editorReducer(s, { type: "arrowRightEdge" })).toBe(s);
  });
});

describe("activateNode", () => {
  it("focuses the given node and enters the specified editing mode", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    const next = editorReducer(s, {
      type: "activateNode",
      nodeId: "a",
      cursorPos: 1,
      selectionEnd: 1,
      editing: true,
    });
    expect(next.activeNodeId).toBe("a");
    expect(next.editingText).toBe("A");
    expect(next.editing).toBe(true);
    expect(next.cursorPos).toBe(1);
    expect(next.selectionEnd).toBe(1);
  });

  it("is a no-op for an unknown node", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    expect(
      editorReducer(s, {
        type: "activateNode",
        nodeId: "nonexistent",
        cursorPos: 0,
        selectionEnd: 0,
        editing: false,
      })
    ).toBe(s);
  });
});

describe("startEditing / exitEditing", () => {
  it("startEditing enters edit mode with cursor defaults", () => {
    const model = sampleModel();
    const s = { ...stateAt(model, "a"), editing: false };
    const next = editorReducer(s, { type: "startEditing" });
    expect(next.editing).toBe(true);
    expect(next.cursorPos).toBe(0);
    expect(next.selectionEnd).toBe(1); // selects whole text ("A".length)
  });

  it("startEditing accepts explicit cursorPos and selectionEnd", () => {
    const model = sampleModel();
    const s = { ...stateAt(model, "a1"), editing: false };
    const next = editorReducer(s, {
      type: "startEditing",
      cursorPos: 1,
      selectionEnd: 2,
    });
    expect(next.cursorPos).toBe(1);
    expect(next.selectionEnd).toBe(2);
  });

  it("startEditing is a no-op without an active node", () => {
    const model = sampleModel();
    const s: EditorState = { ...stateAt(model, "a"), activeNodeId: null };
    expect(editorReducer(s, { type: "startEditing" })).toBe(s);
  });

  it("exitEditing leaves edit mode and selects whole text", () => {
    const model = sampleModel();
    const s = stateAt(model, "a1"); // editing=true from stateAt
    const next = editorReducer(s, { type: "exitEditing" });
    expect(next.editing).toBe(false);
    expect(next.cursorPos).toBe(0);
    expect(next.selectionEnd).toBe(2); // "A1".length
  });

  it("exitEditing is a no-op when not editing", () => {
    const model = sampleModel();
    const s = { ...stateAt(model, "a"), editing: false };
    expect(editorReducer(s, { type: "exitEditing" })).toBe(s);
  });
});

describe("selectAllInNode", () => {
  it("selects all text in the given node and enters edit mode", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    const next = editorReducer(s, { type: "selectAllInNode", nodeId: "a1" });
    expect(next.activeNodeId).toBe("a1");
    expect(next.editing).toBe(true);
    expect(next.editingText).toBe("A1");
    expect(next.cursorPos).toBe(0);
    expect(next.selectionEnd).toBe(2);
  });

  it("is a no-op for an unknown node", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    expect(
      editorReducer(s, { type: "selectAllInNode", nodeId: "missing" })
    ).toBe(s);
  });
});

describe("dragSelect", () => {
  it("same-node drag selects a text range and enters edit mode", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    const next = editorReducer(s, {
      type: "dragSelect",
      anchorNodeId: "a1",
      anchorOffset: 2,
      focusNodeId: "a1",
      focusOffset: 0,
    });
    expect(next.activeNodeId).toBe("a1");
    expect(next.editing).toBe(true);
    expect(next.cursorPos).toBe(0);
    expect(next.selectionEnd).toBe(2);
  });

  it("cross-node drag moves focus without entering edit mode", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    const next = editorReducer(s, {
      type: "dragSelect",
      anchorNodeId: "a",
      anchorOffset: 0,
      focusNodeId: "b",
      focusOffset: 1,
    });
    expect(next.activeNodeId).toBe("b");
    expect(next.editing).toBe(false);
    expect(next.cursorPos).toBe(1);
  });

  it("is a no-op for an unknown focus node", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    expect(
      editorReducer(s, {
        type: "dragSelect",
        anchorNodeId: "a",
        anchorOffset: 0,
        focusNodeId: "missing",
        focusOffset: 0,
      })
    ).toBe(s);
  });
});

describe("insertNodes into root", () => {
  it("inserts nodes as children of the root when root is the target", () => {
    const model = sampleModel();
    const nodes: MindMapModel[] = [
      { id: "n1", text: "X", children: [] },
    ];
    const next = editorReducer(stateAt(model, "root"), {
      type: "insertNodes",
      targetId: "root",
      nodes,
    });
    const root = findNode(next.model, "root")!;
    expect(root.children[root.children.length - 1].text).toBe("X");
    expect(next.activeNodeId).toBe("n1");
  });

  it("insertNodes is a no-op when nodes array is empty", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    expect(
      editorReducer(s, { type: "insertNodes", targetId: "root", nodes: [] })
    ).toBe(s);
  });

  it("insertNodes is a no-op when targetId does not exist in the model", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    const nodes: MindMapModel[] = [{ id: "n1", text: "X", children: [] }];
    expect(
      editorReducer(s, {
        type: "insertNodes",
        targetId: "nonexistent",
        nodes,
      })
    ).toBe(s);
  });
});

describe("toggleCollapse", () => {
  it("collapses a node with children", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    const next = editorReducer(s, { type: "toggleCollapse", nodeId: "a" });
    expect(findNode(next.model, "a")!.collapsed).toBe(true);
  });

  it("moves focus to the collapsed node when active node gets hidden", () => {
    const model = sampleModel();
    const s = stateAt(model, "a1"); // a1 is a descendant of "a"
    const next = editorReducer(s, { type: "toggleCollapse", nodeId: "a" });
    expect(findNode(next.model, "a")!.collapsed).toBe(true);
    expect(next.activeNodeId).toBe("a");
  });

  it("is a no-op for a leaf node", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    expect(
      editorReducer(s, { type: "toggleCollapse", nodeId: "b" })
    ).toBe(s);
  });
});

describe("addChild", () => {
  it("adds a new empty child to a node and focuses it", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    const next = editorReducer(s, { type: "addChild", nodeId: "b" });
    const b = findNode(next.model, "b")!;
    expect(b.children).toHaveLength(1);
    expect(b.children[0].text).toBe("");
    expect(next.activeNodeId).toBe(b.children[0].id);
  });

  it("is a no-op for an unknown nodeId", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    expect(
      editorReducer(s, { type: "addChild", nodeId: "missing" })
    ).toBe(s);
  });
});

describe("deleteNode", () => {
  it("deletes a node and preserves active focus elsewhere", () => {
    const model = sampleModel();
    const s = stateAt(model, "b"); // active = "b", delete "a1"
    const next = editorReducer(s, { type: "deleteNode", nodeId: "a1" });
    expect(findNode(next.model, "a1")).toBeNull();
    expect(next.activeNodeId).toBe("b"); // active unchanged
  });

  it("refocuses when the active node is deleted", () => {
    const model = sampleModel();
    const s = stateAt(model, "a1");
    const next = editorReducer(s, { type: "deleteNode", nodeId: "a1" });
    expect(findNode(next.model, "a1")).toBeNull();
    expect(next.activeNodeId).toBe("a");
  });

  it("is a no-op when trying to delete the root", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    expect(
      editorReducer(s, { type: "deleteNode", nodeId: "root" })
    ).toBe(s);
  });
});

describe("setNodeType", () => {
  it("changes a node's type and focuses it", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    const next = editorReducer(s, {
      type: "setNodeType",
      nodeId: "b",
      nodeType: "link",
    });
    expect(findNode(next.model, "b")!.type).toBe("link");
    expect(next.activeNodeId).toBe("b");
  });

  it("is a no-op for an unknown node", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    expect(
      editorReducer(s, {
        type: "setNodeType",
        nodeId: "missing",
        nodeType: "link",
      })
    ).toBe(s);
  });
});

describe("setNodeContent", () => {
  it("updates text and cursor for the currently active node", () => {
    const model = sampleModel();
    const s = stateAt(model, "a");
    const next = editorReducer(s, {
      type: "setNodeContent",
      nodeId: "a",
      text: "Alpha",
    });
    expect(findNode(next.model, "a")!.text).toBe("Alpha");
    expect(next.editingText).toBe("Alpha");
    expect(next.cursorPos).toBe(5);
  });

  it("updates text without changing cursor for a non-active node", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    const next = editorReducer(s, {
      type: "setNodeContent",
      nodeId: "b",
      text: "Beta",
    });
    expect(findNode(next.model, "b")!.text).toBe("Beta");
    expect(next.activeNodeId).toBe("root"); // focus unchanged
  });

  it("also sets nodeType when provided", () => {
    const model = sampleModel();
    const s = stateAt(model, "b");
    const next = editorReducer(s, {
      type: "setNodeContent",
      nodeId: "b",
      text: "https://example.com",
      nodeType: "link",
    });
    expect(findNode(next.model, "b")!.type).toBe("link");
  });

  it("is a no-op for an unknown node", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    expect(
      editorReducer(s, {
        type: "setNodeContent",
        nodeId: "missing",
        text: "x",
      })
    ).toBe(s);
  });
});

describe("setNodeStyle", () => {
  it("applies font size and bold to a node", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    const next = editorReducer(s, {
      type: "setNodeStyle",
      nodeId: "b",
      fontSize: 20,
      bold: true,
    });
    const b = findNode(next.model, "b")!;
    expect(b.fontSize).toBe(20);
    expect(b.bold).toBe(true);
  });

  it("is a no-op for an unknown node", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    expect(
      editorReducer(s, {
        type: "setNodeStyle",
        nodeId: "missing",
        fontSize: 20,
      })
    ).toBe(s);
  });
});

describe("setLinkMeta", () => {
  it("sets linkTitle and favicon on a node", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    const next = editorReducer(s, {
      type: "setLinkMeta",
      nodeId: "b",
      linkTitle: "Example",
      favicon: "https://example.com/fav.ico",
    });
    const b = findNode(next.model, "b")!;
    expect(b.linkTitle).toBe("Example");
    expect(b.favicon).toBe("https://example.com/fav.ico");
  });

  it("is a no-op for an unknown node", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    expect(
      editorReducer(s, {
        type: "setLinkMeta",
        nodeId: "missing",
        linkTitle: "x",
      })
    ).toBe(s);
  });
});

describe("null activeNodeId no-ops", () => {
  function nullState(model: MindMapModel): EditorState {
    return { ...stateAt(model, "root"), activeNodeId: null };
  }

  it("copyBranch is a no-op without an active node", () => {
    const s = nullState(sampleModel());
    expect(editorReducer(s, { type: "copyBranch" })).toBe(s);
  });

  it("cutBranch is a no-op without an active node", () => {
    const s = nullState(sampleModel());
    expect(editorReducer(s, { type: "cutBranch" })).toBe(s);
  });

  it("pasteBranch is a no-op without an active node", () => {
    const s = nullState(sampleModel());
    expect(editorReducer(s, { type: "pasteBranch" })).toBe(s);
  });

  it("moveUp is a no-op without an active node", () => {
    const s = nullState(sampleModel());
    expect(editorReducer(s, { type: "moveUp" })).toBe(s);
  });

  it("moveDown is a no-op without an active node", () => {
    const s = nullState(sampleModel());
    expect(editorReducer(s, { type: "moveDown" })).toBe(s);
  });

  it("tab is a no-op without an active node", () => {
    const s = nullState(sampleModel());
    expect(editorReducer(s, { type: "tab", shift: false })).toBe(s);
  });

  it("backspaceAtStart is a no-op without an active node", () => {
    const s = nullState(sampleModel());
    expect(editorReducer(s, { type: "backspaceAtStart" })).toBe(s);
  });

  it("cmdLeft is a no-op without an active node", () => {
    const s = nullState(sampleModel());
    expect(editorReducer(s, { type: "cmdLeft", pos: 0 })).toBe(s);
  });

  it("cmdRight is a no-op without an active node", () => {
    const s = nullState(sampleModel());
    expect(editorReducer(s, { type: "cmdRight", pos: 0 })).toBe(s);
  });

  it("cmdShiftLeft is a no-op without an active node", () => {
    const s = nullState(sampleModel());
    expect(editorReducer(s, { type: "cmdShiftLeft", pos: 0, selEnd: 0 })).toBe(s);
  });

  it("arrowLeftEdge is a no-op without an active node", () => {
    const s = nullState(sampleModel());
    expect(editorReducer(s, { type: "arrowLeftEdge" })).toBe(s);
  });

  it("arrowRightEdge is a no-op without an active node", () => {
    const s = nullState(sampleModel());
    expect(editorReducer(s, { type: "arrowRightEdge" })).toBe(s);
  });

  it("typeText is a no-op without an active node", () => {
    const s = nullState(sampleModel());
    expect(
      editorReducer(s, {
        type: "typeText",
        text: "x",
        cursorPos: 1,
        selectionEnd: 1,
        commitModel: true,
      })
    ).toBe(s);
  });
});

describe("replace", () => {
  it("replaces the entire editor state", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    const replacement: EditorState = {
      model: { id: "new", text: "New", children: [] },
      activeNodeId: "new",
      editing: false,
      editingText: "New",
      cursorPos: 0,
      selectionEnd: 3,
      clipboard: null,
    };
    const next = editorReducer(s, { type: "replace", state: replacement });
    expect(next).toBe(replacement);
  });
});
