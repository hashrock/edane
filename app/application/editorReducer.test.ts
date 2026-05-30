import { describe, it, expect } from "vitest";
import type { MindMapModel } from "../domain/model";
import { getFlatOrder, findNode } from "../domain/model";
import {
  editorReducer,
  isMultiNodeSelection,
  type EditorState,
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
    model,
    activeNodeId: nodeId,
    editingText: node.text,
    cursorPos: node.text.length,
    selectionEnd: node.text.length,
    selAnchorNodeId: null,
    selAnchorOffset: 0,
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

describe("multi-node selection", () => {
  it("collapseSelection deletes the range across nodes", () => {
    const model = sampleModel();
    // anchor in "A" at offset 1, focus in "b" at offset 0
    const s: EditorState = {
      model,
      activeNodeId: "b",
      editingText: "B",
      cursorPos: 0,
      selectionEnd: 0,
      selAnchorNodeId: "a",
      selAnchorOffset: 1,
    };
    expect(isMultiNodeSelection(s)).toBe(true);
    const next = editorReducer(s, { type: "collapseSelection" });
    expect(isMultiNodeSelection(next)).toBe(false);
    expect(next.selAnchorNodeId).toBeNull();
    // The nodes between anchor and focus are removed
    const order = getFlatOrder(next.model);
    expect(order).not.toContain("a1");
    expect(order).not.toContain("b");
  });

  it("collapseSelectionAndInsert collapses then inserts a char", () => {
    const model = sampleModel();
    const s: EditorState = {
      model,
      activeNodeId: "b",
      editingText: "B",
      cursorPos: 0,
      selectionEnd: 0,
      selAnchorNodeId: "a",
      selAnchorOffset: 1,
    };
    const next = editorReducer(s, {
      type: "collapseSelectionAndInsert",
      char: "X",
    });
    // collapse merges "A"(before offset 1) + "B"(after offset 0) → "AB",
    // then "X" is inserted at the cursor (offset 1) → "AXB"
    const node = findNode(next.model, next.activeNodeId!)!;
    expect(node.text).toBe("AXB");
    expect(next.cursorPos).toBe(2);
  });
});

describe("extendSelection (Shift+Arrow)", () => {
  // DFS order of sampleModel: root, a, a1, b
  it("starts a multi-node selection downward, anchoring at the caret", () => {
    const model = sampleModel();
    const s = stateAt(model, "a"); // caret at end of "A" (offset 1)
    const next = editorReducer(s, { type: "extendSelectionDown" });
    expect(next.activeNodeId).toBe("a1");
    expect(next.selAnchorNodeId).toBe("a");
    expect(next.selAnchorOffset).toBe(1);
    expect(next.cursorPos).toBe(2); // whole "A1" included
    expect(isMultiNodeSelection(next)).toBe(true);
  });

  it("keeps the original anchor while extending further", () => {
    const model = sampleModel();
    const one = editorReducer(stateAt(model, "a"), {
      type: "extendSelectionDown",
    });
    const two = editorReducer(one, { type: "extendSelectionDown" });
    expect(two.activeNodeId).toBe("b");
    expect(two.selAnchorNodeId).toBe("a");
    expect(two.selAnchorOffset).toBe(1);
    expect(two.cursorPos).toBe(1); // whole "B"
  });

  it("collapses when the focus returns to the anchor node", () => {
    const model = sampleModel();
    const down = editorReducer(stateAt(model, "a"), {
      type: "extendSelectionDown",
    });
    const back = editorReducer(down, { type: "extendSelectionUp" });
    expect(back.activeNodeId).toBe("a");
    expect(back.cursorPos).toBe(1);
    expect(isMultiNodeSelection(back)).toBe(false);
  });

  it("extends upward, focusing the start of nodes above the anchor", () => {
    const model = sampleModel();
    const up = editorReducer(stateAt(model, "a1"), {
      type: "extendSelectionUp",
    });
    expect(up.activeNodeId).toBe("a");
    expect(up.selAnchorNodeId).toBe("a1");
    expect(up.selAnchorOffset).toBe(2);
    expect(up.cursorPos).toBe(0);
    expect(isMultiNodeSelection(up)).toBe(true);
  });

  it("is a no-op at the top edge", () => {
    const model = sampleModel();
    const s = stateAt(model, "root");
    expect(editorReducer(s, { type: "extendSelectionUp" })).toBe(s);
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
