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
      lastChildByParent: {},
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

  it("pasteBranch is a no-op when pasting an object card onto another object card", () => {
    const model: MindMapModel = {
      id: "root",
      text: "Root",
      children: [
        { id: "card1", text: "Card1", type: "object", children: [] },
        { id: "card2", text: "Card2", type: "object", children: [] },
      ],
    };
    const copied = editorReducer(stateAt(model, "card1"), { type: "copyBranch" });
    const onCard2 = withView(copied, { activeNodeId: "card2" });
    expect(editorReducer(onCard2, { type: "pasteBranch" })).toBe(onCard2);
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

  it("exitEditing deletes a blank leaf node and focuses its predecessor", () => {
    // Root -> [A -> [A1(blank)], B]. Flat order: root, a, a1, b.
    const model = sampleModel();
    findNode(model, "a1")!.text = "";
    const s = stateAt(model, "a1"); // editing=true, text ""
    const next = editorReducer(s, { type: "exitEditing" });
    expect(findNode(next.document.model, "a1")).toBeNull();
    expect(next.view.editing).toBe(false);
    expect(next.view.activeNodeId).toBe("a"); // predecessor in flat order
  });

  it("exitEditing treats a whitespace-only node as blank", () => {
    const model = sampleModel();
    findNode(model, "b")!.text = "   ";
    const s = stateAt(model, "b");
    const next = editorReducer(s, { type: "exitEditing" });
    expect(findNode(next.document.model, "b")).toBeNull();
    expect(next.view.activeNodeId).toBe("a1"); // predecessor of b
  });

  it("exitEditing keeps a blank node that still has children", () => {
    const model = sampleModel();
    findNode(model, "a")!.text = ""; // A is blank but has child A1
    const s = stateAt(model, "a");
    const next = editorReducer(s, { type: "exitEditing" });
    expect(findNode(next.document.model, "a")).not.toBeNull();
    expect(next.view.editing).toBe(false);
  });

  it("exitEditing never deletes the root even when blank", () => {
    const model = sampleModel();
    model.text = "";
    // Root has children, but assert the root-id guard holds regardless.
    const s = stateAt(model, "root");
    const next = editorReducer(s, { type: "exitEditing" });
    expect(next.document.model.id).toBe("root");
    expect(next.document).toBe(s.document); // untouched
  });

  it("exitEditing does not delete a non-empty node", () => {
    const model = sampleModel();
    const s = stateAt(model, "a1"); // "A1"
    const next = editorReducer(s, { type: "exitEditing" });
    expect(findNode(next.document.model, "a1")).not.toBeNull();
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
  it("selects a text range within the node and enters edit mode", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    const next = editorReducer(s, {
      type: "dragSelect",
      nodeId: "a1",
      anchorOffset: 2,
      focusOffset: 0,
    });
    expect(next.view.activeNodeId).toBe("a1");
    expect(next.view.editing).toBe(true);
    expect(next.view.cursorPos).toBe(0);
    expect(next.view.selectionEnd).toBe(2);
  });

  it("is a no-op for an unknown node", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    expect(
      editorReducer(s, {
        type: "dragSelect",
        nodeId: "missing",
        anchorOffset: 0,
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

describe("moveBranch", () => {
  it("moves a subtree under a new parent and keeps selection on it", () => {
    const model = sampleModel();
    const s = withView(stateAt(model, "a1"), { editing: false });
    const next = editorReducer(s, {
      type: "moveBranch",
      nodeId: "a1",
      newParentId: "b",
    });
    expect(findNode(next.document.model, "b")!.children.map((c) => c.id)).toEqual(
      ["a1"]
    );
    expect(findNode(next.document.model, "a")!.children).toEqual([]);
    expect(next.view.activeNodeId).toBe("a1"); // focus follows the moved node
    expect(next.view.editing).toBe(false); // selection mode preserved
  });

  it("inserts at the given sibling index", () => {
    const model = sampleModel();
    const s = withView(stateAt(model, "a1"), { editing: false });
    const next = editorReducer(s, {
      type: "moveBranch",
      nodeId: "a1",
      newParentId: "root",
      index: 1,
    });
    expect(next.document.model.children.map((c) => c.id)).toEqual([
      "a",
      "a1",
      "b",
    ]);
  });

  it("expands a collapsed drop target", () => {
    const model = sampleModel();
    findNode(model, "a")!.collapsed = true;
    const s = withView(stateAt(model, "b"), { editing: false });
    const next = editorReducer(s, {
      type: "moveBranch",
      nodeId: "b",
      newParentId: "a",
    });
    const a = findNode(next.document.model, "a")!;
    expect(a.collapsed).toBe(false);
    expect(a.children.map((c) => c.id)).toEqual(["a1", "b"]);
  });

  it("is a no-op (same state) for an invalid move", () => {
    const model = sampleModel();
    const s = withView(stateAt(model, "a"), { editing: false });
    // Into its own descendant.
    expect(
      editorReducer(s, { type: "moveBranch", nodeId: "a", newParentId: "a1" })
    ).toBe(s);
    // Root can't move.
    expect(
      editorReducer(s, { type: "moveBranch", nodeId: "root", newParentId: "b" })
    ).toBe(s);
    // Already the last child of the target.
    expect(
      editorReducer(s, { type: "moveBranch", nodeId: "a1", newParentId: "a" })
    ).toBe(s);
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

describe("moveUpSiblingFirst / moveDownSiblingFirst", () => {
  /** Root → A(A1, A2), B, C */
  function siblingModel(): MindMapModel {
    return {
      id: "root",
      text: "Root",
      children: [
        {
          id: "a",
          text: "A",
          children: [
            { id: "a1", text: "A1", children: [] },
            { id: "a2", text: "A2", children: [] },
          ],
        },
        { id: "b", text: "B", children: [] },
        { id: "c", text: "C", children: [] },
      ],
    };
  }

  it("moves between siblings", () => {
    const model = siblingModel();
    expect(
      editorReducer(stateAt(model, "c"), { type: "moveUpSiblingFirst" }).view
        .activeNodeId
    ).toBe("b");
    expect(
      editorReducer(stateAt(model, "b"), { type: "moveDownSiblingFirst" }).view
        .activeNodeId
    ).toBe("c");
  });

  it("prefers the sibling over the flat order's neighbour", () => {
    // B's predecessor in the flat order is A2, one level down inside A.
    const model = siblingModel();
    expect(
      getFlatOrder(model)[getFlatOrder(model).indexOf("b") - 1]
    ).toBe("a2");
    expect(
      editorReducer(stateAt(model, "b"), { type: "moveUpSiblingFirst" }).view
        .activeNodeId
    ).toBe("a");
  });

  // Preferring siblings must never dead-end: once they run out, ↑/↓ leave the
  // branch, so holding ↓ still gets you out of a subtree.
  it("leaves the branch when the siblings run out", () => {
    const model = siblingModel();
    // Last child of A: no next sibling, so ↓ steps out to A's next sibling.
    expect(
      editorReducer(stateAt(model, "a2"), { type: "moveDownSiblingFirst" }).view
        .activeNodeId
    ).toBe("b");
    // First child of A: ↑ steps out to the parent.
    expect(
      editorReducer(stateAt(model, "a1"), { type: "moveUpSiblingFirst" }).view
        .activeNodeId
    ).toBe("a");
    // First top-level node: ↑ reaches the root.
    expect(
      editorReducer(stateAt(model, "a"), { type: "moveUpSiblingFirst" }).view
        .activeNodeId
    ).toBe("root");
  });

  // The rule that keeps ↓ predictable: whether it descends must NOT depend on
  // where in the tree the node happens to sit. Both of these have children;
  // "a" has a following sibling and "c" is the last child, and neither ↓ opens
  // the branch — going a level deeper is → 's job.
  it("never descends into children, wherever the node sits", () => {
    const model = siblingModel();
    model.children[2].children = [{ id: "c1", text: "C1", children: [] }];
    expect(
      editorReducer(stateAt(model, "a"), { type: "moveDownSiblingFirst" }).view
        .activeNodeId
    ).toBe("b");
    // The flat order WOULD descend here — that asymmetry was the bug.
    expect(getFlatOrder(model)[getFlatOrder(model).indexOf("c") + 1]).toBe("c1");
    const atC = stateAt(model, "c");
    expect(editorReducer(atC, { type: "moveDownSiblingFirst" })).toBe(atC);
  });

  it("climbs past several levels to leave a deep subtree", () => {
    // Root → A(A1(A1a, A1b), A2), B: ↓ from the last leaf of the deepest
    // branch lands on the next node at whatever level has one.
    const model = siblingModel();
    model.children[0].children[0].children = [
      { id: "a1a", text: "A1a", children: [] },
      { id: "a1b", text: "A1b", children: [] },
    ];
    expect(
      editorReducer(stateAt(model, "a1b"), { type: "moveDownSiblingFirst" })
        .view.activeNodeId
    ).toBe("a2");
    // And from A2 (last child of A) out to A's sibling.
    expect(
      editorReducer(stateAt(model, "a2"), { type: "moveDownSiblingFirst" }).view
        .activeNodeId
    ).toBe("b");
  });

  // ↓ stops on the tree's trailing edge — the root, its last child, ITS last
  // child, and so on — because climbing finds no ancestor with a next sibling.
  // Those nodes can still HAVE children; ↓ just won't descend, → will.
  it("is a no-op (same state) along the tree's trailing edge", () => {
    const model = siblingModel();
    model.children[2].children = [{ id: "c1", text: "C1", children: [] }];
    for (const id of ["root", "c", "c1"]) {
      const s = stateAt(model, id);
      expect(editorReducer(s, { type: "moveDownSiblingFirst" })).toBe(s);
    }
    // "c" is on that edge while still having a child to descend into.
    expect(
      editorReducer(stateAt(model, "c"), { type: "moveToChild" }).view
        .activeNodeId
    ).toBe("c1");
    // Nothing above the root either.
    const root = stateAt(model, "root");
    expect(editorReducer(root, { type: "moveUpSiblingFirst" })).toBe(root);
  });

  // An object card renders its children as rows inside the card box, so the
  // title and rows read as one column — the single case where ↓ steps into a
  // node's children. The exception stops at the card's direct rows.
  describe("object cards are one visual column", () => {
    /** Root → Card(r1, r2){type: object}, T */
    function cardModel(collapsed = false): MindMapModel {
      return {
        id: "root",
        text: "Root",
        children: [
          {
            id: "card",
            text: "Card",
            type: "object",
            collapsed,
            children: [
              { id: "r1", text: "価格: 1200", children: [] },
              { id: "r2", text: "在庫: 5", children: [] },
            ],
          },
          { id: "t", text: "T", children: [] },
        ],
      };
    }

    it("walks title → rows → the node after the card", () => {
      const model = cardModel();
      let s = stateAt(model, "card");
      s = editorReducer(s, { type: "moveDownSiblingFirst" });
      expect(s.view.activeNodeId).toBe("r1");
      s = editorReducer(s, { type: "moveDownSiblingFirst" });
      expect(s.view.activeNodeId).toBe("r2");
      s = editorReducer(s, { type: "moveDownSiblingFirst" });
      expect(s.view.activeNodeId).toBe("t");
    });

    it("walks back up out of the card", () => {
      const model = cardModel();
      let s = stateAt(model, "r1");
      s = editorReducer(s, { type: "moveUpSiblingFirst" });
      expect(s.view.activeNodeId).toBe("card");
    });

    it("skips the rows of a folded card", () => {
      const s = stateAt(cardModel(true), "card");
      expect(
        editorReducer(s, { type: "moveDownSiblingFirst" }).view.activeNodeId
      ).toBe("t");
    });

    it("does not descend into a row's own subtree (the card never draws it)", () => {
      const model = cardModel();
      model.children[0].children[0].children = [
        { id: "hidden", text: "隠れた子", children: [] },
      ];
      // r1 has a child, but the card only draws its direct rows: ↓ goes to the
      // next row, exactly as it would without the subtree.
      expect(
        editorReducer(stateAt(model, "r1"), { type: "moveDownSiblingFirst" })
          .view.activeNodeId
      ).toBe("r2");
      // ...and from the last row, out of the card entirely.
      expect(
        editorReducer(stateAt(model, "r2"), { type: "moveDownSiblingFirst" })
          .view.activeNodeId
      ).toBe("t");
    });

    // Deliberate: ↓ on the title always means "the first row", with no memory
    // of having been inside. You leave the card by walking its rows.
    it("re-enters the card when ↓ is pressed on the title again", () => {
      const model = cardModel();
      let s = stateAt(model, "card");
      s = editorReducer(s, { type: "moveDownSiblingFirst" }); // r1
      s = editorReducer(s, { type: "moveToParent" }); // back to the title
      expect(s.view.activeNodeId).toBe("card");
      s = editorReducer(s, { type: "moveDownSiblingFirst" });
      expect(s.view.activeNodeId).toBe("r1");
    });

    it("does not step into an empty card", () => {
      const model = cardModel();
      model.children[0].children = [];
      expect(
        editorReducer(stateAt(model, "card"), { type: "moveDownSiblingFirst" })
          .view.activeNodeId
      ).toBe("t");
    });
  });

  it("records the visited child so ← then → round-trips", () => {
    // Walking siblings must feed lastChildByParent the same way moveDown does.
    const model = siblingModel();
    let s = stateAt(model, "b");
    s = editorReducer(s, { type: "moveDownSiblingFirst" }); // c
    s = editorReducer(s, { type: "moveToParent" }); // root
    expect(editorReducer(s, { type: "moveToChild" }).view.activeNodeId).toBe(
      "c"
    );
  });
});

describe("moveToChild (last-visited-child memory)", () => {
  /** Root → P(p1, p2, p3), Q */
  function branchModel(): MindMapModel {
    return {
      id: "root",
      text: "Root",
      children: [
        {
          id: "p",
          text: "P",
          children: [
            { id: "p1", text: "P1", children: [] },
            { id: "p2", text: "P2", children: [] },
            { id: "p3", text: "P3", children: [] },
          ],
        },
        { id: "q", text: "Q", children: [] },
      ],
    };
  }

  it("lands on the first child when the branch has never been entered", () => {
    const next = editorReducer(stateAt(branchModel(), "p"), {
      type: "moveToChild",
    });
    expect(next.view.activeNodeId).toBe("p1");
  });

  it("returns to the child the focus left from (← then → round-trips)", () => {
    const model = branchModel();
    let s = stateAt(model, "p2");
    s = editorReducer(s, { type: "moveToParent" });
    expect(s.view.activeNodeId).toBe("p");
    s = editorReducer(s, { type: "moveToChild" });
    expect(s.view.activeNodeId).toBe("p2");
  });

  it("remembers where the user stopped, not where they entered", () => {
    // Enter at p1, arrow down to p3, go up to P: → must return to p3.
    const model = branchModel();
    let s = stateAt(model, "p");
    s = editorReducer(s, { type: "moveToChild" }); // p1
    s = editorReducer(s, { type: "moveDown" }); // p2
    s = editorReducer(s, { type: "moveDown" }); // p3
    s = editorReducer(s, { type: "moveToParent" }); // P
    s = editorReducer(s, { type: "moveToChild" });
    expect(s.view.activeNodeId).toBe("p3");
  });

  it("survives a detour through another branch (memory is per parent)", () => {
    const model = branchModel();
    let s = stateAt(model, "p2");
    s = editorReducer(s, { type: "moveToParent" }); // P
    s = editorReducer(s, { type: "moveDown" }); // p1 — visiting P's branch again
    s = editorReducer(s, { type: "moveToParent" }); // P (memory now p1)
    s = editorReducer(s, { type: "activateNode" as const, nodeId: "q", editing: false, cursorPos: 0, selectionEnd: 0 });
    s = editorReducer(s, { type: "activateNode" as const, nodeId: "p", editing: false, cursorPos: 0, selectionEnd: 0 });
    s = editorReducer(s, { type: "moveToChild" });
    expect(s.view.activeNodeId).toBe("p1");
  });

  it("falls back to the first child when the remembered child is gone", () => {
    // A stale entry — the node was deleted, or moved under another parent.
    const model = branchModel();
    const base = stateAt(model, "p");
    const s: EditorState = {
      ...base,
      view: { ...base.view, lastChildByParent: { p: "ghost" } },
    };
    expect(editorReducer(s, { type: "moveToChild" }).view.activeNodeId).toBe(
      "p1"
    );
  });

  it("is a no-op on a leaf", () => {
    const s = stateAt(branchModel(), "q");
    expect(editorReducer(s, { type: "moveToChild" })).toBe(s);
  });

  it("refuses to focus a hidden node: collapsed parents are the caller's job", () => {
    const model = branchModel();
    model.children[0].collapsed = true;
    const s = stateAt(model, "p");
    expect(editorReducer(s, { type: "moveToChild" })).toBe(s);
  });

  it("keeps the record's identity stable when nothing new is recorded", () => {
    const model = branchModel();
    const s = stateAt(model, "p2");
    const up = editorReducer(s, { type: "moveToParent" });
    const down = editorReducer(up, { type: "moveToChild" });
    // Re-recording p2 under P must not allocate a new record.
    expect(down.view.lastChildByParent).toBe(up.view.lastChildByParent);
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

  it("deletes the whole subtree, removing children too (no promotion)", () => {
    const model = sampleModel();
    const s = stateAt(model, "a"); // active = "a", which has child "a1"
    const next = editorReducer(s, { type: "deleteNode", nodeId: "a" });
    // "a" and its child "a1" are both gone; the child is NOT promoted to root.
    expect(findNode(next.document.model, "a")).toBeNull();
    expect(findNode(next.document.model, "a1")).toBeNull();
    // Root's remaining children are just "b".
    expect(next.document.model.children.map((c) => c.id)).toEqual(["b"]);
    // Active node "a" disappeared → refocus to root (no surviving previous node).
    expect(next.view.activeNodeId).toBe("root");
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

  it("refocuses onto the changed node when a nodeType change hides the active node", () => {
    // "hidden" is a GRANDCHILD of "a" (child of its row "a1"); converting "a"
    // to an object card hides grandchildren (only the direct child rows stay
    // visible), so the previously-active "hidden" would otherwise dangle
    // outside the flat order.
    const model: MindMapModel = {
      id: "root",
      text: "Root",
      children: [
        {
          id: "a",
          text: "A",
          children: [
            { id: "a1", text: "a1: v", children: [{ id: "hidden", text: "H", children: [] }] },
          ],
        },
      ],
    };
    const s = stateAt(model, "hidden");
    const next = editorReducer(s, {
      type: "setNodeContent",
      nodeId: "a",
      text: "A",
      nodeType: "object",
    });
    expect(next.view.activeNodeId).toBe("a");
    expect(getFlatOrder(next.document.model)).toContain(next.view.activeNodeId);
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
        lastChildByParent: {},
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
      lastChildByParent: {},
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
      lastChildByParent: {},
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
      lastChildByParent: {},
    };
    const reconciled = reconcileView(view, document);
    expect(reconciled.activeNodeId).toBe(model.id);
  });

  it("lands on the previous node when the active node vanishes and prevDocument is given", () => {
    // Flat order in prevDocument: root, a, a1, b. The restored document has
    // "b" removed, so the previously-active "b" must refocus onto its
    // predecessor "a1" rather than jumping all the way to the root.
    const prev = sampleModel();
    const prevDocument: DocumentState = { model: prev, clipboard: null };
    const restored: MindMapModel = {
      ...prev,
      children: prev.children.filter((c) => c.id !== "b"),
    };
    const document: DocumentState = { model: restored, clipboard: null };
    const view: ViewState = {
      activeNodeId: "b",
      editing: true,
      editingText: "B",
      cursorPos: 1,
      selectionEnd: 1,
      lastChildByParent: {},
    };
    const reconciled = reconcileView(view, document, prevDocument);
    expect(reconciled.activeNodeId).toBe("a1");
    expect(reconciled.editing).toBe(false);
    expect(reconciled.editingText).toBe("A1");
    expect(reconciled.cursorPos).toBe(0);
  });

  it("falls back to the next node when no previous neighbour survives", () => {
    // Restored document drops the whole "a" branch (a, a1). The vanished "a1"
    // has no surviving predecessor except the root, but the next node "b"
    // survives and sits closer, so it wins.
    const prev = sampleModel();
    const prevDocument: DocumentState = { model: prev, clipboard: null };
    const restored: MindMapModel = {
      ...prev,
      children: prev.children.filter((c) => c.id !== "a"),
    };
    const document: DocumentState = { model: restored, clipboard: null };
    const view: ViewState = {
      activeNodeId: "a1",
      editing: false,
      editingText: "A1",
      cursorPos: 0,
      selectionEnd: 0,
      lastChildByParent: {},
    };
    const reconciled = reconcileView(view, document, prevDocument);
    expect(reconciled.activeNodeId).toBe("b");
  });
});
