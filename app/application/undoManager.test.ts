import { describe, it, expect, vi } from "vitest";
import type { DocumentState } from "./editorReducer";
import { UndoManager } from "./undoManager";

/** Minimal DocumentState whose root text doubles as a label for assertions. */
function st(tag: string): DocumentState {
  return {
    model: { id: "r", text: tag, children: [] },
    clipboard: null,
  };
}

describe("UndoManager transactions", () => {
  it("clear() resets an open transaction", () => {
    const m = new UndoManager();
    m.beginTransaction("reorder", st("a"));
    m.clear();
    expect(m.inTransaction()).toBe(false);
    m.push("move-branch", st("a"), st("b"));
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

});
