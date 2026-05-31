/**
 * Application layer: command-based undo/redo manager.
 * Stores before/after EditorState pairs for each undoable operation.
 * Text typing is batched via a debounce timer.
 */

import type { EditorState } from "./editorReducer";

export interface UndoableCommand {
  type: string;
  stateBefore: EditorState;
  stateAfter: EditorState;
}

const MAX_STACK_SIZE = 200;
const TEXT_BATCH_DELAY = 400;

export class UndoManager {
  private undoStack: UndoableCommand[] = [];
  private redoStack: UndoableCommand[] = [];

  // Text batching
  private pendingTextBefore: EditorState | null = null;
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private onCommitPending: (() => void) | null = null;

  // Transaction batching: groups several dispatches into one undo entry so a
  // single logical operation (e.g. paste = delete-then-insert) undoes/redoes
  // atomically. Supports nesting via a depth counter.
  private txDepth = 0;
  private txBefore: EditorState | null = null;
  private txType = "";

  /** Set a callback to get the current state when committing pending text */
  setCommitCallback(fn: () => EditorState) {
    this.onCommitPending = () => {
      if (this.pendingTextBefore) {
        const stateAfter = fn();
        this.pushCommand({
          type: "text",
          stateBefore: this.pendingTextBefore,
          stateAfter,
        });
        this.pendingTextBefore = null;
      }
    };
  }

  /** Call on each text keystroke. Batches into a single undo entry. */
  handleTextChange(currentState: EditorState) {
    if (!this.pendingTextBefore) {
      this.pendingTextBefore = currentState;
    }
    // Reset debounce timer
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = setTimeout(() => {
      this.commitPendingText();
    }, TEXT_BATCH_DELAY);
  }

  /** Commit any pending text batch. Call before structural commands. */
  commitPendingText() {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    if (this.onCommitPending) {
      this.onCommitPending();
    }
  }

  hasPendingText(): boolean {
    return this.pendingTextBefore !== null;
  }

  /** Push a structural (non-text) command */
  pushCommand(cmd: UndoableCommand) {
    this.undoStack.push(cmd);
    if (this.undoStack.length > MAX_STACK_SIZE) {
      this.undoStack.shift();
    }
    // Any new action clears redo
    this.redoStack = [];
  }

  /** Push a structural command with before/after states */
  push(type: string, stateBefore: EditorState, stateAfter: EditorState) {
    // Inside a transaction, individual pushes are absorbed by the enclosing
    // transaction's single before/after pair.
    if (this.txDepth > 0) return;
    this.commitPendingText();
    this.pushCommand({ type, stateBefore, stateAfter });
  }

  /**
   * Begin grouping subsequent dispatches into one undo entry. Must be paired
   * with endTransaction(). `before` is the state captured before the group.
   */
  beginTransaction(type: string, before: EditorState) {
    if (this.txDepth === 0) {
      this.commitPendingText();
      this.txBefore = before;
      this.txType = type;
    }
    this.txDepth++;
  }

  /** Close the current transaction, pushing one command if the state changed. */
  endTransaction(after: EditorState) {
    if (this.txDepth === 0) return;
    this.txDepth--;
    if (this.txDepth === 0 && this.txBefore) {
      if (this.txBefore !== after) {
        this.pushCommand({
          type: this.txType,
          stateBefore: this.txBefore,
          stateAfter: after,
        });
      }
      this.txBefore = null;
      this.txType = "";
    }
  }

  inTransaction(): boolean {
    return this.txDepth > 0;
  }

  undo(): EditorState | null {
    this.commitPendingText();
    const cmd = this.undoStack.pop();
    if (!cmd) return null;
    this.redoStack.push(cmd);
    return cmd.stateBefore;
  }

  redo(): EditorState | null {
    const cmd = this.redoStack.pop();
    if (!cmd) return null;
    this.undoStack.push(cmd);
    return cmd.stateAfter;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0 || this.pendingTextBefore !== null;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
    this.pendingTextBefore = null;
    this.txDepth = 0;
    this.txBefore = null;
    this.txType = "";
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
  }
}
