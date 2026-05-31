import { describe, it, expect } from "vitest";
import type { EditorState } from "./editorReducer";
import { UndoManager } from "./undoManager";

/** Minimal EditorState whose root text doubles as a label for assertions. */
function st(tag: string): EditorState {
  return {
    model: { id: "r", text: tag, children: [] },
    activeNodeId: null,
    editing: false,
    editingText: "",
    cursorPos: 0,
    selectionEnd: 0,
    clipboard: null,
  };
}

describe("UndoManager", () => {
  it("undo returns the before-state and redo returns the after-state", () => {
    const m = new UndoManager();
    const before = st("a");
    const after = st("b");
    m.push("edit", before, after);

    expect(m.undo()).toBe(before);
    expect(m.canRedo()).toBe(true);
    expect(m.redo()).toBe(after);
  });

  it("a new command clears the redo stack", () => {
    const m = new UndoManager();
    m.push("one", st("a"), st("b"));
    m.undo();
    expect(m.canRedo()).toBe(true);
    m.push("two", st("b"), st("c"));
    expect(m.canRedo()).toBe(false);
  });
});

describe("UndoManager transactions", () => {
  it("groups several pushes into a single undo entry", () => {
    const m = new UndoManager();
    const before = st("start");
    const mid = st("mid");
    const after = st("end");

    m.beginTransaction("paste", before);
    m.push("delete", before, mid); // absorbed
    m.push("insert", mid, after); // absorbed
    m.endTransaction(after);

    // One entry: undo jumps straight back to the pre-transaction state.
    expect(m.undo()).toBe(before);
    expect(m.canUndo()).toBe(false);
    expect(m.redo()).toBe(after);
  });

  it("pushes nothing when the transaction made no change", () => {
    const m = new UndoManager();
    const before = st("same");
    m.beginTransaction("noop", before);
    m.endTransaction(before);
    expect(m.canUndo()).toBe(false);
  });

  it("supports nested transactions (only the outermost commits)", () => {
    const m = new UndoManager();
    const before = st("a");
    const after = st("d");

    m.beginTransaction("outer", before);
    m.beginTransaction("inner", st("b"));
    m.push("x", st("b"), st("c"));
    m.endTransaction(st("c")); // inner: does not commit
    expect(m.canUndo()).toBe(false);
    m.endTransaction(after); // outer: commits one entry
    expect(m.undo()).toBe(before);
  });

  it("clear() resets an open transaction", () => {
    const m = new UndoManager();
    m.beginTransaction("t", st("a"));
    m.clear();
    expect(m.inTransaction()).toBe(false);
    m.push("after", st("a"), st("b"));
    expect(m.canUndo()).toBe(true);
  });
});
