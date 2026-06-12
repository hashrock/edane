import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

describe("UndoManager text batching", () => {
  it("hasPendingText returns false initially", () => {
    const m = new UndoManager();
    expect(m.hasPendingText()).toBe(false);
  });

  it("handleTextChange sets pendingTextBefore on first call", () => {
    const m = new UndoManager();
    const s = st("initial");
    m.handleTextChange(s);
    expect(m.hasPendingText()).toBe(true);
    m.clear();
  });

  it("setCommitCallback + commitPendingText pushes the text command", () => {
    const m = new UndoManager();
    const before = st("before");
    const after = st("after");

    m.setCommitCallback(() => after);
    m.handleTextChange(before);
    expect(m.hasPendingText()).toBe(true);

    m.commitPendingText();
    expect(m.hasPendingText()).toBe(false);
    expect(m.canUndo()).toBe(true);
    expect(m.undo()).toBe(before);
  });

  it("commitPendingText is a no-op when no pending text", () => {
    const m = new UndoManager();
    m.commitPendingText(); // should not throw
    expect(m.canUndo()).toBe(false);
  });

  it("canUndo is true when there is pending text even with no stack entries", () => {
    const m = new UndoManager();
    m.handleTextChange(st("x"));
    expect(m.canUndo()).toBe(true);
    m.clear();
  });

  it("pushCommand respects MAX_STACK_SIZE (200 entries)", () => {
    const m = new UndoManager();
    for (let i = 0; i < 201; i++) {
      m.pushCommand({ type: "t", stateBefore: st(`s${i}`), stateAfter: st(`s${i + 1}`) });
    }
    // Stack should be capped at 200 — the oldest entry was evicted.
    let count = 0;
    while (m.undo()) count++;
    expect(count).toBe(200);
  });

  it("clear() cancels a pending debounce timer", () => {
    const m = new UndoManager();
    m.handleTextChange(st("x")); // starts timer
    m.clear(); // should cancel timer and clear pending
    expect(m.hasPendingText()).toBe(false);
  });

  it("debounce timer fires commitPendingText after delay", async () => {
    vi.useFakeTimers();
    const m = new UndoManager();
    const before = st("before");
    const after = st("after");
    m.setCommitCallback(() => after);
    m.handleTextChange(before);
    expect(m.hasPendingText()).toBe(true);
    vi.advanceTimersByTime(400);
    expect(m.hasPendingText()).toBe(false);
    expect(m.canUndo()).toBe(true);
    vi.useRealTimers();
  });

  it("endTransaction is a no-op when not in a transaction", () => {
    const m = new UndoManager();
    m.endTransaction(st("a")); // should not throw or push anything
    expect(m.canUndo()).toBe(false);
  });

  it("redo returns null when redo stack is empty", () => {
    const m = new UndoManager();
    expect(m.redo()).toBeNull();
  });

  it("handleTextChange called twice preserves the first state as pendingTextBefore", () => {
    const m = new UndoManager();
    const first = st("first");
    const second = st("second");
    const final = st("final");
    m.setCommitCallback(() => final);
    m.handleTextChange(first);
    m.handleTextChange(second); // should NOT overwrite pendingTextBefore
    m.commitPendingText();
    // undo should restore "first" (the state before any typing)
    expect(m.undo()).toBe(first);
    m.clear();
  });
});
