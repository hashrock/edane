import { describe, it, expect } from "vitest";
import type { MindMapDocument, MindMapModel } from "../domain/model";
import { getFlatOrder, findNode, updateNodeText } from "../domain/model";
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

/** Build a small fixed document (two roots):
 *  A
 *    A1
 *  B
 */
function sampleModel(): MindMapDocument {
  return {
    title: "Root",
    roots: [
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
function stateAt(model: MindMapDocument, nodeId: string): EditorState {
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
    const s = stateAt(model, "a1");
    const next = editorReducer(withView(s, { cursorPos: 0, selectionEnd: 0 }), {
      type: "enter",
      pos: 0,
    });
    // Splitting "A1" at pos 0 → empty sibling before it; "A1" keeps its node.
    const a = findNode(next.document.model, "a")!;
    expect(a.children.map((c) => c.text)).toEqual(["", "A1"]);
  });

  it("on a tree root, Enter adds a child — never a sibling tree", () => {
    const model = sampleModel();
    // At the end: appended as the last child.
    const atEnd = editorReducer(stateAt(model, "b"), { type: "enter", pos: 1 });
    expect(findNode(atEnd.document.model, "b")!.children.map((c) => c.text)).toEqual([""]);
    expect(atEnd.document.model.roots.map((c) => c.id)).toEqual(["a", "b"]);
    // At the start: an empty first child.
    const atStart = editorReducer(
      withView(stateAt(model, "a"), { cursorPos: 0, selectionEnd: 0 }),
      { type: "enter", pos: 0 }
    );
    expect(findNode(atStart.document.model, "a")!.children.map((c) => c.text)).toEqual(["", "A1"]);
    expect(atStart.document.model.roots.map((c) => c.id)).toEqual(["a", "b"]);
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

  it("dedents a child of a root into a new root after it", () => {
    const model = sampleModel();
    const next = editorReducer(stateAt(model, "a1"), {
      type: "tab",
      shift: true,
    });
    expect(next.document.model.roots.map((c) => c.text)).toEqual(["A", "A1", "B"]);
  });

  it("indents a root under the previous root (joining the trees)", () => {
    const model = sampleModel();
    findNode(model, "b")!.position = { x: 10, y: 20 };
    const next = editorReducer(stateAt(model, "b"), { type: "tab", shift: false });
    expect(next.document.model.roots.map((c) => c.id)).toEqual(["a"]);
    const a = findNode(next.document.model, "a")!;
    expect(a.children.map((c) => c.id)).toEqual(["a1", "b"]);
    // A tree's canvas position only applies while it is a root.
    expect(findNode(next.document.model, "b")!.position).toBeUndefined();
  });
});

describe("backspaceAtStart", () => {
  it("removes an empty node and moves to the previous node", () => {
    const model: MindMapDocument = {
      title: "Root",
      roots: [
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
    const model: MindMapDocument = {
      title: "Root",
      roots: [
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

  it("does nothing at the first root (nothing before it)", () => {
    const model = sampleModel();
    const s = withView(stateAt(model, "a"), {
      cursorPos: 0,
      selectionEnd: 0,
    });
    expect(editorReducer(s, { type: "backspaceAtStart" })).toBe(s);
  });

  it("merges a later root into the previous root (the roots are siblings)", () => {
    // Roots: A -> [A1], B. Backspace at the start of B joins the trees.
    const model = sampleModel();
    const s = withView(stateAt(model, "b"), { cursorPos: 0, selectionEnd: 0 });
    const next = editorReducer(s, { type: "backspaceAtStart" });
    expect(next.document.model.roots.map((r) => r.id)).toEqual(["a"]);
    expect(findNode(next.document.model, "a")!.text).toBe("AB");
    expect(next.view.activeNodeId).toBe("a");
  });
});

describe("deleteAtEnd", () => {
  it("refreshes editingText with the merged text (the textarea shows editingText)", () => {
    // Roots [A -> [A1], B]. Delete at the end of "A" pulls "A1" up into it;
    // the textarea is bound to editingText, so a stale "A" here would be
    // written back over the merged "AA1" by the very next keystroke.
    const model = sampleModel();
    const s = stateAt(model, "a");
    const next = editorReducer(s, { type: "deleteAtEnd", pos: 1 });
    expect(findNode(next.document.model, "a")!.text).toBe("AA1");
    expect(next.view.editingText).toBe("AA1");
    expect(next.view.cursorPos).toBe(1);
  });

  it("merges the next sibling into the current node", () => {
    // Roots [x "X", y "Y" -> y1] ; Delete at end of x pulls y up into x,
    // and y's children come along with its text.
    const model: MindMapDocument = {
      title: "Root",
      roots: [
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

  it("puts the caret on the join, not on the reported position", () => {
    // Was "click -> ⌘Z -> Delete at end" (#147): undo left a stale editingText,
    // so the textarea reported a caret past the model's text. reconcileView now
    // re-reads the buffer, so that route cannot produce the out-of-range caret
    // any more — but deleteAtEnd's own contract still has to hold, so it is
    // dispatched directly instead of being reached through undo.
    const model = updateNodeText(sampleModel(), "a", "AB"); // a "AB" -> [a1 "A1"]
    const s = stateAt(model, "a");
    for (const pos of [2, 99]) {
      const next = editorReducer(s, { type: "deleteAtEnd", pos });
      expect(findNode(next.document.model, "a")!.text).toBe("ABA1");
      expect(next.view.editingText).toBe("ABA1");
      expect(next.view.cursorPos).toBe(2);
      expect(next.view.selectionEnd).toBe(2);
    }
  });
});

describe("undo while editing (the document moves under the textarea)", () => {
  it("clamps a click that lands past the restored text", () => {
    // activateNode and dragSelect build a view literal directly rather than
    // going through focusView; on canvas their offsets are computed from the
    // painted text, so a click can name a position the model no longer has.
    // (That reconcileView refreshes the buffer at all is covered by its own
    // tests below, and end-to-end by MindmapEditor.undo.browser.test.tsx.)
    const editing = editorReducer(
      stateAt(updateNodeText(sampleModel(), "a", "AB"), "b"),
      { type: "activateNode", nodeId: "a", cursorPos: 2, selectionEnd: 2, editing: true }
    );
    // ⌘Z: restore the shorter document, carrying the view over as-is.
    const s = editorReducer(editing, {
      type: "replace",
      state: { document: { model: sampleModel(), clipboard: null }, view: editing.view },
    });

    const clicked = editorReducer(s, {
      type: "activateNode",
      nodeId: "a",
      cursorPos: 2,
      selectionEnd: 2,
      editing: true,
    });
    expect(clicked.view.editingText).toBe("A");
    expect(clicked.view.cursorPos).toBe(1);

    const dragged = editorReducer(s, {
      type: "dragSelect",
      nodeId: "a",
      anchorOffset: 0,
      focusOffset: 2,
    });
    expect(dragged.view.selectionEnd).toBe(1);
  });
});

describe("navigation", () => {
  it("moveUp / moveDown walk DFS order", () => {
    const model = sampleModel();
    const order = getFlatOrder(model); // a, a1, b
    const down = editorReducer(stateAt(model, "a"), { type: "moveDown" });
    expect(down.view.activeNodeId).toBe(order[order.indexOf("a") + 1]);
    const up = editorReducer(stateAt(model, "a1"), { type: "moveUp" });
    expect(up.view.activeNodeId).toBe("a");
  });

  it("moveUp is a no-op at the first node", () => {
    const model = sampleModel();
    const s = stateAt(model, "a");
    expect(editorReducer(s, { type: "moveUp" })).toBe(s);
  });
});

describe("branch clipboard (cut / copy / paste)", () => {
  // DFS order of sampleModel: a, a1, b
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
    expect(getFlatOrder(next.document.model)).toEqual(["b"]); // a + a1 gone
    expect(next.document.clipboard!.text).toBe("A");
    expect(next.document.clipboard!.children[0].text).toBe("A1");
  });

  it("cutBranch lands focus on the previous node in flat order", () => {
    const model = sampleModel();
    const next = editorReducer(stateAt(model, "b"), { type: "cutBranch" });
    // before "b" in DFS (a, a1, b) is "a1"
    expect(next.view.activeNodeId).toBe("a1");
  });

  it("cutBranch on the last root leaves one fresh blank root that takes the focus", () => {
    const model: MindMapDocument = {
      title: "Root",
      roots: [{ id: "only", text: "Only", children: [{ id: "c", text: "C", children: [] }] }],
    };
    const next = editorReducer(stateAt(model, "only"), { type: "cutBranch" });
    expect(next.document.clipboard!.text).toBe("Only");
    expect(next.document.model.roots).toHaveLength(1);
    const blank = next.document.model.roots[0];
    expect(blank.id).not.toBe("only");
    expect(blank.text).toBe("");
    expect(next.view.activeNodeId).toBe(blank.id);
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
    const collapsedA: MindMapDocument = {
      ...model,
      roots: model.roots.map((c) =>
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
    const next = editorReducer(stateAt(model, "a1"), {
      type: "insertNodes",
      targetId: "a1",
      nodes,
    });
    const a = findNode(next.document.model, "a")!;
    expect(a.children.map((c) => c.text)).toEqual(["A1", "X", "Y"]);
    expect(next.view.activeNodeId).toBe("n2");
  });

  it("inserts under a tree root as its children — never as new trees", () => {
    const model = sampleModel();
    const nodes: MindMapModel[] = [{ id: "n1", text: "X", children: [] }];
    const next = editorReducer(stateAt(model, "b"), {
      type: "insertNodes",
      targetId: "b",
      nodes,
    });
    expect(next.document.model.roots.map((c) => c.id)).toEqual(["a", "b"]);
    expect(findNode(next.document.model, "b")!.children.map((c) => c.id)).toEqual(["n1"]);
  });

  it("addRootAt is the way to create a tree: blank, placed, editing", () => {
    const model = sampleModel();
    const next = editorReducer(stateAt(model, "a"), { type: "addRootAt", x: 400, y: 50 });
    const roots = next.document.model.roots;
    expect(roots.map((c) => c.id).slice(0, 2)).toEqual(["a", "b"]);
    expect(roots[2].text).toBe("");
    expect(roots[2].position).toEqual({ x: 400, y: 50 });
    expect(next.view.activeNodeId).toBe(roots[2].id);
    expect(next.view.editing).toBe(true);
  });

});

describe("setTitle", () => {
  it("updates the document title and leaves the trees untouched", () => {
    const model = sampleModel();
    const next = editorReducer(stateAt(model, "a"), {
      type: "setTitle",
      text: "New Title",
    });
    expect(next.document.model.title).toBe("New Title");
    expect(next.document.model.roots.map(stripIds)).toEqual(model.roots.map(stripIds));
  });

  it("never touches the view (the title is not a node)", () => {
    const model = sampleModel();
    const s = stateAt(model, "a");
    const next = editorReducer(s, { type: "setTitle", text: "New Title" });
    expect(next.view).toBe(s.view);
  });

  it("is a no-op (same state) when the title is unchanged", () => {
    const model = sampleModel();
    const s = stateAt(model, "a");
    expect(editorReducer(s, { type: "setTitle", text: "Root" })).toBe(s);
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
    // "a" is idx=0, so pos=0 does not jump to a previous node
    const s = withView(stateAt(model, "a"), {
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
    const s = stateAt(model, "a");
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
    const s = stateAt(model, "a");
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
    const s = stateAt(model, "a");
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

  it("exitEditing in selection mode keeps a blank leaf node (empty-canvas click, post-paste)", () => {
    // The blank-node cleanup is for LEAVING edit mode; in selection mode the
    // document must not change, or the view would point at a deleted node.
    const model = sampleModel();
    findNode(model, "a1")!.text = "";
    const s = withView(stateAt(model, "a1"), { editing: false });
    expect(editorReducer(s, { type: "exitEditing" })).toBe(s);
  });

  it("exitEditing deletes a blank leaf node and focuses its predecessor", () => {
    // Roots [A -> [A1(blank)], B]. Flat order: a, a1, b.
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

  it("exitEditing never deletes the only root even when blank", () => {
    const model: MindMapDocument = {
      title: "Root",
      roots: [{ id: "only", text: "", children: [] }],
    };
    const s = stateAt(model, "only");
    const next = editorReducer(s, { type: "exitEditing" });
    expect(next.document).toBe(s.document); // untouched
    expect(next.view.editing).toBe(false);
  });

  it("exitEditing deletes a blank root that is not the only one", () => {
    const model = sampleModel();
    findNode(model, "b")!.text = "";
    const next = editorReducer(stateAt(model, "b"), { type: "exitEditing" });
    expect(next.document.model.roots.map((r) => r.id)).toEqual(["a"]);
    expect(next.view.activeNodeId).toBe("a1"); // predecessor of b
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
    const s = stateAt(model, "a");
    const next = editorReducer(s, { type: "selectAllInNode", nodeId: "a1" });
    expect(next.view.activeNodeId).toBe("a1");
    expect(next.view.editing).toBe(true);
    expect(next.view.editingText).toBe("A1");
    expect(next.view.cursorPos).toBe(0);
    expect(next.view.selectionEnd).toBe(2);
  });

  it("is a no-op for an unknown node", () => {
    const model = sampleModel();
    const s = stateAt(model, "a");
    expect(
      editorReducer(s, { type: "selectAllInNode", nodeId: "missing" })
    ).toBe(s);
  });
});

describe("dragSelect", () => {
  it("selects a text range within the node and enters edit mode", () => {
    const model = sampleModel();
    const s = stateAt(model, "a");
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
    const s = stateAt(model, "a");
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

describe("insertNodes on a root", () => {
  it("appends the nodes as the root's children (expanding it) when a root is the target", () => {
    const model = sampleModel();
    findNode(model, "a")!.collapsed = true;
    const nodes: MindMapModel[] = [{ id: "n1", text: "X", children: [] }];
    const next = editorReducer(stateAt(model, "a"), {
      type: "insertNodes",
      targetId: "a",
      nodes,
    });
    const a = findNode(next.document.model, "a")!;
    expect(a.children.map((c) => c.id)).toEqual(["a1", "n1"]);
    expect(a.collapsed).toBe(false);
    expect(next.view.activeNodeId).toBe("n1");
  });

  it("insertNodes is a no-op when nodes array is empty", () => {
    const model = sampleModel();
    const s = stateAt(model, "a");
    expect(
      editorReducer(s, { type: "insertNodes", targetId: "a", nodes: [] })
    ).toBe(s);
  });

  it("insertNodes is a no-op when targetId does not exist in the model", () => {
    const model = sampleModel();
    const s = stateAt(model, "a");
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
    const s = stateAt(model, "a");
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
    const s = stateAt(model, "a");
    expect(editorReducer(s, { type: "toggleCollapse", nodeId: "b" })).toBe(s);
  });
});

describe("moveNodeUp / moveNodeDown", () => {
  it("moves the active node down among its siblings (roots included), keeping focus", () => {
    const model = sampleModel();
    const s = stateAt(model, "a");
    const next = editorReducer(s, { type: "moveNodeDown" });
    expect(next.document.model.roots.map((c) => c.id)).toEqual(["b", "a"]);
    expect(next.view.activeNodeId).toBe("a"); // focus follows the moved node
    expect(next.view.editing).toBe(true); // mode preserved
  });

  it("moves the active node up among its siblings", () => {
    const model = sampleModel();
    const s = stateAt(model, "b");
    const next = editorReducer(s, { type: "moveNodeUp" });
    expect(next.document.model.roots.map((c) => c.id)).toEqual(["b", "a"]);
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
    // Root "b" moves under "a" as its first child (before a1).
    const model = sampleModel();
    const s = withView(stateAt(model, "b"), { editing: false });
    const next = editorReducer(s, {
      type: "moveBranch",
      nodeId: "b",
      newParentId: "a",
      index: 0,
    });
    expect(next.document.model.roots.map((c) => c.id)).toEqual(["a"]);
    expect(findNode(next.document.model, "a")!.children.map((c) => c.id)).toEqual(["b", "a1"]);
  });

  it("a root nested under a node loses its canvas position", () => {
    const model = sampleModel();
    findNode(model, "b")!.position = { x: 5, y: 6 };
    const s = withView(stateAt(model, "b"), { editing: false });
    const next = editorReducer(s, { type: "moveBranch", nodeId: "b", newParentId: "a" });
    expect(findNode(next.document.model, "b")!.position).toBeUndefined();
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
    // Unknown node.
    expect(
      editorReducer(s, { type: "moveBranch", nodeId: "ghost", newParentId: "b" })
    ).toBe(s);
    // Already the last child of the target.
    expect(
      editorReducer(s, { type: "moveBranch", nodeId: "a1", newParentId: "a" })
    ).toBe(s);
  });
});

describe("moveToParent", () => {
  it("is a no-op (same state) on a root", () => {
    const model = sampleModel();
    const s = stateAt(model, "b");
    expect(editorReducer(s, { type: "moveToParent" })).toBe(s);
  });
});

describe("moveUpSiblingFirst / moveDownSiblingFirst", () => {
  /** Roots: A(A1, A2), B, C */
  function siblingModel(): MindMapDocument {
    return {
      title: "Root",
      roots: [
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

  it("records the visited child so ← then → round-trips", () => {
    // Walking siblings must feed lastChildByParent the same way moveDown does.
    const model = siblingModel();
    let s = stateAt(model, "a1");
    s = editorReducer(s, { type: "moveDownSiblingFirst" }); // a2
    s = editorReducer(s, { type: "moveToParent" }); // a
    expect(editorReducer(s, { type: "moveToChild" }).view.activeNodeId).toBe(
      "a2"
    );
  });

  it("walks the roots as siblings of one another and stops at the document's edges", () => {
    const model = siblingModel();
    let s = stateAt(model, "a");
    expect(editorReducer(s, { type: "moveUpSiblingFirst" })).toBe(s); // first root: nothing above
    s = editorReducer(s, { type: "moveDownSiblingFirst" });
    expect(s.view.activeNodeId).toBe("b"); // never a2 (↓ never descends)
    s = editorReducer(s, { type: "moveDownSiblingFirst" });
    expect(s.view.activeNodeId).toBe("c");
    expect(editorReducer(s, { type: "moveDownSiblingFirst" })).toBe(s); // trailing edge
    // From a2 (last child of a): over the subtree to the next root.
    const fromA2 = editorReducer(stateAt(model, "a2"), { type: "moveDownSiblingFirst" });
    expect(fromA2.view.activeNodeId).toBe("b");
  });
});

describe("moveToChild (last-visited-child memory)", () => {
  /** Roots: P(p1, p2, p3), Q */
  function branchModel(): MindMapDocument {
    return {
      title: "Root",
      roots: [
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
    model.roots[0].collapsed = true;
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
    const s = stateAt(model, "a");
    const next = editorReducer(s, { type: "addChild", nodeId: "b" });
    const b = findNode(next.document.model, "b")!;
    expect(b.children).toHaveLength(1);
    expect(b.children[0].text).toBe("");
    expect(next.view.activeNodeId).toBe(b.children[0].id);
  });

  it("is a no-op for an unknown nodeId", () => {
    const model = sampleModel();
    const s = stateAt(model, "a");
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

  it("is a no-op for an unknown node", () => {
    const model = sampleModel();
    const s = stateAt(model, "a");
    expect(editorReducer(s, { type: "deleteNode", nodeId: "ghost" })).toBe(s);
  });

  it("deleting the last root leaves one fresh blank root that takes the focus", () => {
    const model: MindMapDocument = {
      title: "Root",
      roots: [{ id: "only", text: "Only", children: [] }],
    };
    const next = editorReducer(stateAt(model, "only"), { type: "deleteNode", nodeId: "only" });
    expect(next.document.model.roots).toHaveLength(1);
    const blank = next.document.model.roots[0];
    expect(blank.id).not.toBe("only");
    expect(blank.text).toBe("");
    expect(next.view.activeNodeId).toBe(blank.id);
  });

  it("deletes the whole subtree, removing children too (no promotion)", () => {
    const model = sampleModel();
    const s = stateAt(model, "a"); // active = "a", which has child "a1"
    const next = editorReducer(s, { type: "deleteNode", nodeId: "a" });
    // "a" and its child "a1" are both gone; the child is NOT promoted to a root.
    expect(findNode(next.document.model, "a")).toBeNull();
    expect(findNode(next.document.model, "a1")).toBeNull();
    // The remaining roots are just "b".
    expect(next.document.model.roots.map((c) => c.id)).toEqual(["b"]);
    // Active node "a" disappeared → refocus to the first root (no surviving
    // previous node).
    expect(next.view.activeNodeId).toBe("b");
  });
});

describe("setNodeType", () => {
  it("changes a node's type and focuses it", () => {
    const model = sampleModel();
    const s = stateAt(model, "a");
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
    const s = stateAt(model, "a");
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
    const s = stateAt(model, "a");
    const next = editorReducer(s, {
      type: "setNodeContent",
      nodeId: "b",
      text: "Beta",
    });
    expect(findNode(next.document.model, "b")!.text).toBe("Beta");
    expect(next.view.activeNodeId).toBe("a"); // focus unchanged
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
    const s = stateAt(model, "a");
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
    const s = stateAt(model, "a");
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
    const s = stateAt(model, "a");
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
    const s = stateAt(model, "a");
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
    const s = stateAt(model, "a");
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
  function nullState(model: MindMapDocument): EditorState {
    return withView(stateAt(model, "a"), { activeNodeId: null });
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
    const s = stateAt(model, "a");
    const replacement: EditorState = {
      document: {
        model: {
          title: "New",
          roots: [{ id: "n", text: "N", children: [] }],
        },
        clipboard: null,
      },
      view: {
        activeNodeId: "n",
        editing: false,
        editingText: "N",
        cursorPos: 0,
        selectionEnd: 1,
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

  it("re-reads editingText from the restored node and clamps the caret", () => {
    // The view's editingText is the textarea's value; a document swap moves the
    // model out from under it. Undoing an edit to the node being edited used to
    // leave the pre-undo text on screen, so ⌘Z looked like it did nothing.
    const document: DocumentState = { model: sampleModel(), clipboard: null };
    const view: ViewState = {
      activeNodeId: "a",
      editing: true,
      editingText: "AB", // pre-undo; the restored node says "A"
      cursorPos: 2,
      selectionEnd: 2,
      lastChildByParent: {},
    };
    const reconciled = reconcileView(view, document);
    expect(reconciled.editingText).toBe("A");
    expect(reconciled.cursorPos).toBe(1);
    expect(reconciled.selectionEnd).toBe(1);
    // Still editing the same node — only the buffer was reconciled.
    expect(reconciled.activeNodeId).toBe("a");
    expect(reconciled.editing).toBe(true);
  });

  it("keeps the caret where it was when the restored text still contains it", () => {
    const document: DocumentState = {
      model: updateNodeText(sampleModel(), "a", "ALPHA"),
      clipboard: null,
    };
    const view: ViewState = {
      activeNodeId: "a",
      editing: true,
      editingText: "ALPHAX",
      cursorPos: 1,
      selectionEnd: 1,
      lastChildByParent: {},
    };
    const reconciled = reconcileView(view, document);
    expect(reconciled.editingText).toBe("ALPHA");
    expect(reconciled.cursorPos).toBe(1);
  });

  it("lands on the collapsed ancestor when the active node exists but is hidden", () => {
    // Undo of "expand A" while the user had moved into a1: a1 is still in the
    // document but no longer visible, and an invisible active node traps the
    // keyboard just like a vanished one.
    const model = sampleModel();
    findNode(model, "a")!.collapsed = true;
    const document: DocumentState = { model, clipboard: null };
    const view: ViewState = {
      activeNodeId: "a1",
      editing: true,
      editingText: "A1",
      cursorPos: 2,
      selectionEnd: 2,
      lastChildByParent: {},
    };
    const reconciled = reconcileView(view, document);
    expect(reconciled.activeNodeId).toBe("a");
    expect(reconciled.editing).toBe(false);
  });

  it("falls back to the first root when activeNodeId no longer exists", () => {
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
    expect(reconciled.activeNodeId).toBe(model.roots[0].id);
    expect(reconciled.editing).toBe(false);
    expect(reconciled.editingText).toBe(model.roots[0].text);
    expect(reconciled.cursorPos).toBe(0);
    expect(reconciled.selectionEnd).toBe(0);
  });

  it("falls back to the first root when activeNodeId is null", () => {
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
    expect(reconciled.activeNodeId).toBe(model.roots[0].id);
  });

  it("lands on the previous node when the active node vanishes and prevDocument is given", () => {
    // Flat order in prevDocument: a, a1, b. The restored document has "b"
    // removed, so the previously-active "b" must refocus onto its predecessor
    // "a1" rather than jumping all the way to the first root.
    const prev = sampleModel();
    const prevDocument: DocumentState = { model: prev, clipboard: null };
    const restored: MindMapDocument = {
      ...prev,
      roots: prev.roots.filter((c) => c.id !== "b"),
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
    // has no surviving predecessor, but the next node "b" survives, so it wins.
    const prev = sampleModel();
    const prevDocument: DocumentState = { model: prev, clipboard: null };
    const restored: MindMapDocument = {
      ...prev,
      roots: prev.roots.filter((c) => c.id !== "a"),
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

describe("multi-selection (issue #171)", () => {
  it("setSelectedIds stores the given ids, deduped and filtered to ones that exist", () => {
    const model = sampleModel();
    const next = editorReducer(stateAt(model, "a"), {
      type: "setSelectedIds",
      ids: ["a", "b", "a", "nonexistent"],
    });
    expect(next.view.selectedIds).toEqual(["a", "b"]);
  });

  it("an empty ids array clears the selection back to absent", () => {
    const model = sampleModel();
    const selected = editorReducer(stateAt(model, "a"), {
      type: "setSelectedIds",
      ids: ["a", "b"],
    });
    const cleared = editorReducer(selected, { type: "setSelectedIds", ids: [] });
    expect(cleared.view.selectedIds).toBeUndefined();
  });

  it("setCheckedMany applies the same checked state to every listed node in one edit", () => {
    const model = sampleModel();
    const next = editorReducer(stateAt(model, "a"), {
      type: "setCheckedMany",
      nodeIds: ["a", "b"],
      checked: true,
    });
    expect(findNode(next.document.model, "a")!.checked).toBe(true);
    expect(findNode(next.document.model, "b")!.checked).toBe(true);
  });

  it("setCheckedMany is a no-op (same reference) for an empty id list", () => {
    const model = sampleModel();
    const state = stateAt(model, "a");
    const next = editorReducer(state, {
      type: "setCheckedMany",
      nodeIds: [],
      checked: true,
    });
    expect(next).toBe(state);
  });

  it("setCheckedMany leaves the selection in place for a follow-up bulk action", () => {
    const model = sampleModel();
    const selected = editorReducer(stateAt(model, "a"), {
      type: "setSelectedIds",
      ids: ["a", "b"],
    });
    const toggled = editorReducer(selected, {
      type: "setCheckedMany",
      nodeIds: ["a", "b"],
      checked: true,
    });
    expect(toggled.view.selectedIds).toEqual(["a", "b"]);
  });

  it("every other action clears a stale multi-selection — even a click on a selected node", () => {
    const model = sampleModel();
    const selected = editorReducer(stateAt(model, "a"), {
      type: "setSelectedIds",
      ids: ["a", "b"],
    });
    const clicked = editorReducer(selected, {
      type: "activateNode",
      nodeId: "a",
      cursorPos: 0,
      selectionEnd: 1,
      editing: false,
    });
    expect(clicked.view.selectedIds).toBeUndefined();
  });

  it("a plain structural edit (typing) clears the selection too", () => {
    const model = sampleModel();
    const selected = editorReducer(stateAt(model, "a"), {
      type: "setSelectedIds",
      ids: ["a", "b"],
    });
    const typed = editorReducer(selected, {
      type: "typeText",
      text: "Az",
      cursorPos: 2,
      selectionEnd: 2,
      commitModel: true,
    });
    expect(typed.view.selectedIds).toBeUndefined();
  });

  it("undo/redo (replace) never resurrects a stale multi-selection", () => {
    const model = sampleModel();
    const base = stateAt(model, "a");
    const staleView: ViewState = { ...base.view, selectedIds: ["a", "b"] };
    const next = editorReducer(base, {
      type: "replace",
      state: { document: base.document, view: staleView },
    });
    expect(next.view.selectedIds).toBeUndefined();
  });
});
