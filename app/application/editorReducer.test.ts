import { describe, it, expect } from "vitest";
import type { MindMapModel } from "../domain/model";
import { getFlatOrder, findNode } from "../domain/model";
import {
  editorReducer,
  reconcileView,
  type EditorState,
  type DocumentState,
  type ViewState,
} from "./editorReducer";

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
    document: { model, clipboard: null },
    view: {
      activeNodeId: nodeId,
      editing: true,
      editingText: node.text,
      cursorPos: node.text.length,
      selectionEnd: node.text.length,
    },
  };
}

function withView(s: EditorState, patch: Partial<ViewState>): EditorState {
  return { ...s, view: { ...s.view, ...patch } };
}

function withDocument(
  s: EditorState,
  patch: Partial<DocumentState>
): EditorState {
  return { ...s, document: { ...s.document, ...patch } };
}

describe("enter", () => {
  it("appends an empty sibling when cursor is at end", () => {
    const model = sampleModel();
    const next = editorReducer(stateAt(model, "a1"), {
      type: "enter",
      pos: 2,
    });
    // a1's parent is "a"; new empty node added after a1 under "a"
    const a = findNode(next.document.model, "a")!;
    expect(a.children.map((c) => c.text)).toEqual(["A1", ""]);
    expect(next.view.activeNodeId).not.toBe("a1");
    expect(next.view.editingText).toBe("");
    expect(next.view.cursorPos).toBe(0);
  });

  it("splits a node at the cursor", () => {
    const model = sampleModel();
    const s = stateAt(model, "a");
    const next = editorReducer(withView(s, { cursorPos: 0, selectionEnd: 0 }), {
      type: "enter",
      pos: 0,
    });
    // Splitting "A" at pos 0 → empty node before "A" portion; new node holds "A"
    const root = findNode(next.document.model, "root")!;
    expect(root.children.map((c) => c.text)).toEqual(["", "A", "B"]);
  });

  it("is a no-op without an active node", () => {
    const model = sampleModel();
    const s = withView(stateAt(model, "a"), { activeNodeId: null });
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
    const a = findNode(next.document.model, "a")!;
    expect(a.children.map((c) => c.text)).toEqual(["A1", "B"]);
  });

  it("dedents a node to its grandparent level", () => {
    const model = sampleModel();
    const next = editorReducer(stateAt(model, "a1"), {
      type: "tab",
      shift: true,
    });
    const root = findNode(next.document.model, "root")!;
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
    expect(findNode(next.document.model, "empty")).toBeNull();
    expect(next.view.activeNodeId).toBe("a");
    expect(next.view.cursorPos).toBe(1);
  });

  it("merges a non-empty node into its previous sibling (not the DFS-previous leaf)", () => {
    const model = sampleModel();
    // "b"'s DFS-previous node is "a1" (a's child), but its structural
    // predecessor is the previous sibling "a". The merge must target "a" and
    // leave a1 in place, instead of splicing "B" into an unrelated subtree.
    const s = withView(stateAt(model, "b"), { cursorPos: 0, selectionEnd: 0 });
    const next = editorReducer(s, { type: "backspaceAtStart" });
    expect(findNode(next.document.model, "b")).toBeNull();
    const a = findNode(next.document.model, "a")!;
    expect(a.text).toBe("AB");
    expect(a.children.map((c) => c.id)).toEqual(["a1"]);
    expect(findNode(next.document.model, "a1")!.text).toBe("A1");
    expect(next.view.activeNodeId).toBe("a");
    expect(next.view.cursorPos).toBe(1);
  });

  it("merges a first child into its parent, keeping the subtree together", () => {
    // Root -> A -> [A1 -> A1a] ; backspace at start of A1 (first child) merges
    // it into parent A and A1's children take A1's former slot.
    const model: MindMapModel = {
      id: "root",
      text: "Root",
      children: [
        {
          id: "a",
          text: "A",
          children: [
            { id: "a1", text: "A1", children: [{ id: "a1a", text: "A1a", children: [] }] },
          ],
        },
      ],
    };
    const s = withView(stateAt(model, "a1"), { cursorPos: 0, selectionEnd: 0 });
    const next = editorReducer(s, { type: "backspaceAtStart" });
    const a = findNode(next.document.model, "a")!;
    expect(a.text).toBe("AA1");
    expect(findNode(next.document.model, "a1")).toBeNull();
    expect(a.children.map((c) => c.id)).toEqual(["a1a"]);
    expect(next.view.activeNodeId).toBe("a");
    expect(next.view.cursorPos).toBe(1);
  });

  it("does nothing at the root node", () => {
    const model = sampleModel();
    const s = withView(stateAt(model, "root"), {
      cursorPos: 0,
      selectionEnd: 0,
    });
    expect(editorReducer(s, { type: "backspaceAtStart" })).toBe(s);
  });
});

describe("deleteAtEnd", () => {
  it("merges the next sibling into the current node", () => {
    // Root -> [x "X", y "Y" -> y1] ; Delete at end of x pulls y up into x,
    // and y's children come along with its text.
    const model: MindMapModel = {
      id: "root",
      text: "Root",
      children: [
        { id: "x", text: "X", children: [] },
        {
          id: "y",
          text: "Y",
          children: [{ id: "y1", text: "Y1", children: [] }],
        },
      ],
    };
    const next = editorReducer(stateAt(model, "x"), {
      type: "deleteAtEnd",
      pos: 1,
    });
    expect(findNode(next.document.model, "y")).toBeNull();
    const x = findNode(next.document.model, "x")!;
    expect(x.text).toBe("XY");
    expect(x.children.map((c) => c.id)).toEqual(["y1"]);
    expect(next.view.cursorPos).toBe(1);
  });

  it("merges the first visible child up when the node has children", () => {
    const model = sampleModel(); // a -> a1
    const next = editorReducer(stateAt(model, "a"), {
      type: "deleteAtEnd",
      pos: 1,
    });
    const a = findNode(next.document.model, "a")!;
    expect(a.text).toBe("AA1");
    expect(findNode(next.document.model, "a1")).toBeNull();
    expect(next.view.cursorPos).toBe(1);
  });

  it("is a no-op when the DFS-next node lives in an unrelated subtree", () => {
    // a1 has no child and no next sibling; the DFS-next node "b" belongs to a
    // different branch, so nothing merges (mirror of backspaceAtStart).
    const model = sampleModel();
    const s = stateAt(model, "a1");
    expect(editorReducer(s, { type: "deleteAtEnd", pos: 2 })).toBe(s);
  });
});

describe("navigation", () => {
  it("moveUp / moveDown walk DFS order", () => {
    const model = sampleModel();
    const order = getFlatOrder(model); // root, a, a1, b
    const down = editorReducer(stateAt(model, "a"), { type: "moveDown" });
    expect(down.view.activeNodeId).toBe(order[order.indexOf("a") + 1]);
    const up = editorReducer(stateAt(model, "a1"), { type: "moveUp" });
    expect(up.view.activeNodeId).toBe("a");
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
    expect(next.document.model).toBe(model); // model unchanged
    expect(next.document.clipboard).not.toBeNull();
    expect(next.document.clipboard!.text).toBe("A");
    expect(next.document.clipboard!.children[0].text).toBe("A1");
  });

  it("cutBranch removes the node with its descendants and stores them", () => {
    const model = sampleModel();
    const next = editorReducer(stateAt(model, "a"), { type: "cutBranch" });
    expect(getFlatOrder(next.document.model)).toEqual(["root", "b"]); // a + a1 gone
    expect(next.document.clipboard!.text).toBe("A");
    expect(next.document.clipboard!.children[0].text).toBe("A1");
  });

  it("cutBranch lands focus on the previous node in flat order", () => {
    const model = sampleModel();
    const next = editorReducer(stateAt(model, "b"), { type: "cutBranch" });
    // before "b" in DFS (root, a, a1, b) is "a1"
    expect(next.view.activeNodeId).toBe("a1");
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
    const onB = withView(copied, { activeNodeId: "b", editingText: "B" });
    const next = editorReducer(onB, { type: "pasteBranch" });
    const b = findNode(next.document.model, "b")!;
    expect(b.children).toHaveLength(1);
    expect(b.children[0].text).toBe("A");
    expect(b.children[0].children[0].text).toBe("A1");
    // focus moves to the pasted subtree root
    expect(next.view.activeNodeId).toBe(b.children[0].id);
  });

  it("pasteBranch assigns fresh ids (no clash with the source)", () => {
    const model = sampleModel();
    const copied = editorReducer(stateAt(model, "a"), { type: "copyBranch" });
    const onB = withView(copied, { activeNodeId: "b", editingText: "B" });
    const next = editorReducer(onB, { type: "pasteBranch" });
    const pasted = findNode(next.document.model, "b")!.children[0];
    expect(pasted.id).not.toBe("a");
    expect(pasted.children[0].id).not.toBe("a1");
    // original "a" still present and untouched
    expect(findNode(next.document.model, "a")).not.toBeNull();
  });

  it("cut → select → paste moves a branch under a new parent", () => {
    const model = sampleModel();
    const cut = editorReducer(stateAt(model, "a"), { type: "cutBranch" });
    expect(findNode(cut.document.model, "a")).toBeNull();
    const onB = withView(cut, { activeNodeId: "b", editingText: "B" });
    const moved = editorReducer(onB, { type: "pasteBranch" });
    const b = findNode(moved.document.model, "b")!;
    expect(b.children[0].text).toBe("A");
    expect(b.children[0].children[0].text).toBe("A1");
  });

  it("copy → paste twice yields two independent subtrees", () => {
    const model = sampleModel();
    const copied = editorReducer(stateAt(model, "a"), { type: "copyBranch" });
    const onB = withView(copied, { activeNodeId: "b", editingText: "B" });
    const once = editorReducer(onB, { type: "pasteBranch" });
    const twice = editorReducer(withView(once, { activeNodeId: "b" }), {
      type: "pasteBranch",
    });
    const b = findNode(twice.document.model, "b")!;
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
    const onA = withDocument(
      withView(copied, { activeNodeId: "a", editingText: "A" }),
      { model: collapsedA }
    );
    const next = editorReducer(onA, { type: "pasteBranch" });
    expect(findNode(next.document.model, "a")!.collapsed).toBeFalsy();
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
    expect(findNode(next.document.model, "a")!.text).toBe("Apple");
    expect(next.view.editingText).toBe("Apple");
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
    expect(findNode(next.document.model, "a")!.text).toBe("A");
    expect(next.view.editingText).toBe("あ");
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
    const root = findNode(next.document.model, "root")!;
    expect(root.children.map((c) => c.text)).toEqual(["A", "X", "Y", "B"]);
    expect(next.view.activeNodeId).toBe("n2");
  });
});

describe("setTitle", () => {
  it("updates the root node text", () => {
    const model = sampleModel();
    const next = editorReducer(stateAt(model, "a"), {
      type: "setTitle",
      text: "New Title",
    });
    expect(next.document.model.text).toBe("New Title");
    expect(stripIds(next.document.model.children[0])).toEqual(
      stripIds(model.children[0])
    );
  });

  it("keeps the root editing buffer in sync when the root is active", () => {
    const model = sampleModel();
    const next = editorReducer(stateAt(model, "root"), {
      type: "setTitle",
      text: "New Title",
    });
    expect(next.document.model.text).toBe("New Title");
    expect(next.view.editingText).toBe("New Title");
  });

  it("clamps the root caret when the edited title gets shorter", () => {
    const model = sampleModel();
    const s = withView(stateAt(model, "root"), {
      cursorPos: 4,
      selectionEnd: 4,
    });
    const next = editorReducer(s, {
      type: "setTitle",
      text: "R",
    });
    expect(next.view.cursorPos).toBe(1);
    expect(next.view.selectionEnd).toBe(1);
  });
});

describe("no-op convention", () => {
  it("returns the same reference for setSelection with identical values", () => {
    const model = sampleModel();
    const s = stateAt(model, "a");
    expect(
      editorReducer(s, {
        type: "setSelection",
        cursorPos: s.view.cursorPos,
        selectionEnd: s.view.selectionEnd,
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
    expect(next.view.cursorPos).toBe(0);
    expect(next.view.selectionEnd).toBe(1);
  });

  it("deleteAtEnd is a no-op when cursor is not at end", () => {
    const model = sampleModel();
    const s = withView(stateAt(model, "a1"), {
      cursorPos: 1,
      selectionEnd: 1,
    });
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
    const s = withView(stateAt(model, "b"), { cursorPos: 0, selectionEnd: 0 });
    const next = editorReducer(s, { type: "cmdLeft", pos: 0 });
    expect(next.view.activeNodeId).toBe("a1");
    expect(next.view.cursorPos).toBe(2);
  });

  it("cmdLeft not at start jumps cursor to start of current node", () => {
    const model = sampleModel();
    const s = withView(stateAt(model, "a"), { cursorPos: 1, selectionEnd: 1 });
    const next = editorReducer(s, { type: "cmdLeft", pos: 1 });
    expect(next.view.activeNodeId).toBe("a");
    expect(next.view.cursorPos).toBe(0);
    expect(next.view.selectionEnd).toBe(0);
  });

  it("cmdLeft is a no-op when already at start of first node", () => {
    const model = sampleModel();
    // root is idx=0, so pos=0 does not jump to a previous node
    const s = withView(stateAt(model, "root"), {
      cursorPos: 0,
      selectionEnd: 0,
    });
    expect(editorReducer(s, { type: "cmdLeft", pos: 0 })).toBe(s);
  });

  it("cmdRight at end jumps to start of next node", () => {
    const model = sampleModel();
    const s = stateAt(model, "a1"); // cursor at end of "A1"
    const next = editorReducer(s, { type: "cmdRight", pos: 2 });
    expect(next.view.activeNodeId).toBe("b");
    expect(next.view.cursorPos).toBe(0);
    expect(next.view.selectionEnd).toBe(0);
  });

  it("cmdRight not at end jumps cursor to end of current node", () => {
    const model = sampleModel();
    const s = withView(stateAt(model, "a"), { cursorPos: 0, selectionEnd: 0 });
    const next = editorReducer(s, { type: "cmdRight", pos: 0 });
    expect(next.view.activeNodeId).toBe("a");
    expect(next.view.cursorPos).toBe(1);
    expect(next.view.selectionEnd).toBe(1);
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
    const s = withView(stateAt(model, "a"), { cursorPos: 0, selectionEnd: 1 });
    const next = editorReducer(s, {
      type: "cmdShiftLeft",
      pos: 0,
      selEnd: 1,
    });
    expect(next.view.cursorPos).toBe(0);
    expect(next.view.selectionEnd).toBe(1);
  });

  it("cmdShiftRight extends selection to end of node", () => {
    const model = sampleModel();
    const s = withView(stateAt(model, "a1"), {
      cursorPos: 0,
      selectionEnd: 0,
    });
    const next = editorReducer(s, {
      type: "cmdShiftRight",
      pos: 0,
      selEnd: 2,
    });
    expect(next.view.cursorPos).toBe(0);
    expect(next.view.selectionEnd).toBe(2);
  });
});

describe("arrowLeftEdge / arrowRightEdge", () => {
  it("arrowLeftEdge moves focus to previous node", () => {
    const model = sampleModel();
    const s = stateAt(model, "b");
    const next = editorReducer(s, { type: "arrowLeftEdge" });
    expect(next.view.activeNodeId).toBe("a1");
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
    expect(next.view.activeNodeId).toBe("b");
    expect(next.view.cursorPos).toBe(0);
    expect(next.view.selectionEnd).toBe(0);
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
    expect(next.view.activeNodeId).toBe("a");
    expect(next.view.editingText).toBe("A");
    expect(next.view.editing).toBe(true);
    expect(next.view.cursorPos).toBe(1);
    expect(next.view.selectionEnd).toBe(1);
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
    const s = withView(stateAt(model, "a"), { editing: false });
    const next = editorReducer(s, { type: "startEditing" });
    expect(next.view.editing).toBe(true);
    expect(next.view.cursorPos).toBe(0);
    expect(next.view.selectionEnd).toBe(1); // selects whole text ("A".length)
  });

  it("startEditing accepts explicit cursorPos and selectionEnd", () => {
    const model = sampleModel();
    const s = withView(stateAt(model, "a1"), { editing: false });
    const next = editorReducer(s, {
      type: "startEditing",
      cursorPos: 1,
      selectionEnd: 2,
    });
    expect(next.view.cursorPos).toBe(1);
    expect(next.view.selectionEnd).toBe(2);
  });

  it("startEditing is a no-op without an active node", () => {
    const model = sampleModel();
    const s = withView(stateAt(model, "a"), { activeNodeId: null });
    expect(editorReducer(s, { type: "startEditing" })).toBe(s);
  });

  it("exitEditing leaves edit mode and selects whole text", () => {
    const model = sampleModel();
    const s = stateAt(model, "a1"); // editing=true from stateAt
    const next = editorReducer(s, { type: "exitEditing" });
    expect(next.view.editing).toBe(false);
    expect(next.view.cursorPos).toBe(0);
    expect(next.view.selectionEnd).toBe(2); // "A1".length
  });

  it("exitEditing is a no-op when not editing", () => {
    const model = sampleModel();
    const s = withView(stateAt(model, "a"), { editing: false });
    expect(editorReducer(s, { type: "exitEditing" })).toBe(s);
  });
});

describe("selectAllInNode", () => {
  it("selects all text in the given node and enters edit mode", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    const next = editorReducer(s, { type: "selectAllInNode", nodeId: "a1" });
    expect(next.view.activeNodeId).toBe("a1");
    expect(next.view.editing).toBe(true);
    expect(next.view.editingText).toBe("A1");
    expect(next.view.cursorPos).toBe(0);
    expect(next.view.selectionEnd).toBe(2);
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
    expect(next.view.activeNodeId).toBe("a1");
    expect(next.view.editing).toBe(true);
    expect(next.view.cursorPos).toBe(0);
    expect(next.view.selectionEnd).toBe(2);
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
    expect(next.view.activeNodeId).toBe("b");
    expect(next.view.editing).toBe(false);
    expect(next.view.cursorPos).toBe(1);
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
    const nodes: MindMapModel[] = [{ id: "n1", text: "X", children: [] }];
    const next = editorReducer(stateAt(model, "root"), {
      type: "insertNodes",
      targetId: "root",
      nodes,
    });
    const root = findNode(next.document.model, "root")!;
    expect(root.children[root.children.length - 1].text).toBe("X");
    expect(next.view.activeNodeId).toBe("n1");
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
    expect(findNode(next.document.model, "a")!.collapsed).toBe(true);
  });

  it("moves focus to the collapsed node when active node gets hidden", () => {
    const model = sampleModel();
    const s = stateAt(model, "a1"); // a1 is a descendant of "a"
    const next = editorReducer(s, { type: "toggleCollapse", nodeId: "a" });
    expect(findNode(next.document.model, "a")!.collapsed).toBe(true);
    expect(next.view.activeNodeId).toBe("a");
  });

  it("is a no-op for a leaf node", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    expect(editorReducer(s, { type: "toggleCollapse", nodeId: "b" })).toBe(s);
  });
});

describe("moveNodeUp / moveNodeDown", () => {
  it("moves the active node down among its siblings, keeping focus", () => {
    const model = sampleModel();
    const s = stateAt(model, "a");
    const next = editorReducer(s, { type: "moveNodeDown" });
    const root = findNode(next.document.model, "root")!;
    expect(root.children.map((c) => c.id)).toEqual(["b", "a"]);
    expect(next.view.activeNodeId).toBe("a"); // focus follows the moved node
    expect(next.view.editing).toBe(true); // mode preserved
  });

  it("moves the active node up among its siblings", () => {
    const model = sampleModel();
    const s = stateAt(model, "b");
    const next = editorReducer(s, { type: "moveNodeUp" });
    const root = findNode(next.document.model, "root")!;
    expect(root.children.map((c) => c.id)).toEqual(["b", "a"]);
    expect(next.view.activeNodeId).toBe("b");
  });

  it("is a no-op (same state) when already the first child", () => {
    const model = sampleModel();
    const s = stateAt(model, "a");
    expect(editorReducer(s, { type: "moveNodeUp" })).toBe(s);
  });

  it("is a no-op (same state) when already the last child", () => {
    const model = sampleModel();
    const s = stateAt(model, "b");
    expect(editorReducer(s, { type: "moveNodeDown" })).toBe(s);
  });

  it("is a no-op without an active node", () => {
    const model = sampleModel();
    const s = withView(stateAt(model, "a"), { activeNodeId: null });
    expect(editorReducer(s, { type: "moveNodeUp" })).toBe(s);
  });
});

describe("moveToParent", () => {
  it("moves focus to the active node's parent", () => {
    const model = sampleModel();
    const s = stateAt(model, "a1");
    const next = editorReducer(s, { type: "moveToParent" });
    expect(next.view.activeNodeId).toBe("a");
  });

  it("is a no-op (same state) on the root", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    expect(editorReducer(s, { type: "moveToParent" })).toBe(s);
  });
});

describe("addChild", () => {
  it("adds a new empty child to a node and focuses it", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    const next = editorReducer(s, { type: "addChild", nodeId: "b" });
    const b = findNode(next.document.model, "b")!;
    expect(b.children).toHaveLength(1);
    expect(b.children[0].text).toBe("");
    expect(next.view.activeNodeId).toBe(b.children[0].id);
  });

  it("is a no-op for an unknown nodeId", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    expect(editorReducer(s, { type: "addChild", nodeId: "missing" })).toBe(s);
  });
});

describe("deleteNode", () => {
  it("deletes a node and preserves active focus elsewhere", () => {
    const model = sampleModel();
    const s = stateAt(model, "b"); // active = "b", delete "a1"
    const next = editorReducer(s, { type: "deleteNode", nodeId: "a1" });
    expect(findNode(next.document.model, "a1")).toBeNull();
    expect(next.view.activeNodeId).toBe("b"); // active unchanged
  });

  it("refocuses when the active node is deleted", () => {
    const model = sampleModel();
    const s = stateAt(model, "a1");
    const next = editorReducer(s, { type: "deleteNode", nodeId: "a1" });
    expect(findNode(next.document.model, "a1")).toBeNull();
    expect(next.view.activeNodeId).toBe("a");
  });

  it("is a no-op when trying to delete the root", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    expect(editorReducer(s, { type: "deleteNode", nodeId: "root" })).toBe(s);
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
    expect(findNode(next.document.model, "b")!.type).toBe("link");
    expect(next.view.activeNodeId).toBe("b");
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
    expect(findNode(next.document.model, "a")!.text).toBe("Alpha");
    expect(next.view.editingText).toBe("Alpha");
    expect(next.view.cursorPos).toBe(5);
  });

  it("updates text without changing cursor for a non-active node", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    const next = editorReducer(s, {
      type: "setNodeContent",
      nodeId: "b",
      text: "Beta",
    });
    expect(findNode(next.document.model, "b")!.text).toBe("Beta");
    expect(next.view.activeNodeId).toBe("root"); // focus unchanged
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
    expect(findNode(next.document.model, "b")!.type).toBe("link");
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
    const b = findNode(next.document.model, "b")!;
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
    const b = findNode(next.document.model, "b")!;
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
    return withView(stateAt(model, "root"), { activeNodeId: null });
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
    expect(editorReducer(s, { type: "cmdShiftLeft", pos: 0, selEnd: 0 })).toBe(
      s
    );
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
      document: {
        model: { id: "new", text: "New", children: [] },
        clipboard: null,
      },
      view: {
        activeNodeId: "new",
        editing: false,
        editingText: "New",
        cursorPos: 0,
        selectionEnd: 3,
      },
    };
    const next = editorReducer(s, { type: "replace", state: replacement });
    expect(next).toBe(replacement);
  });
});

describe("reconcileView", () => {
  it("keeps the view unchanged when activeNodeId still exists in the document", () => {
    const model = sampleModel();
    const document: DocumentState = { model, clipboard: null };
    const view: ViewState = {
      activeNodeId: "a1",
      editing: true,
      editingText: "A1",
      cursorPos: 2,
      selectionEnd: 2,
    };
    expect(reconcileView(view, document)).toBe(view);
  });

  it("falls back to the document root when activeNodeId no longer exists", () => {
    // Simulates undo restoring a document where the previously-active node
    // (e.g. a pasted branch) has been removed.
    const model = sampleModel();
    const document: DocumentState = { model, clipboard: null };
    const view: ViewState = {
      activeNodeId: "no-longer-exists",
      editing: true,
      editingText: "stale",
      cursorPos: 3,
      selectionEnd: 3,
    };
    const reconciled = reconcileView(view, document);
    expect(reconciled.activeNodeId).toBe(model.id);
    expect(reconciled.editing).toBe(false);
    expect(reconciled.editingText).toBe(model.text);
    expect(reconciled.cursorPos).toBe(0);
    expect(reconciled.selectionEnd).toBe(0);
  });

  it("falls back to the document root when activeNodeId is null", () => {
    const model = sampleModel();
    const document: DocumentState = { model, clipboard: null };
    const view: ViewState = {
      activeNodeId: null,
      editing: false,
      editingText: "",
      cursorPos: 0,
      selectionEnd: 0,
    };
    const reconciled = reconcileView(view, document);
    expect(reconciled.activeNodeId).toBe(model.id);
  });
});
