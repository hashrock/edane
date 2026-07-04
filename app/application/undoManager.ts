/**
 * Application layer: command-based undo/redo manager.
 * Stores before/after DocumentState pairs for each undoable operation.
 * ViewState (selection/caret) is intentionally out of scope: undoing an
 * operation restores the document without moving focus.
 * Text typing is batched via a debounce timer.
 */

import type { DocumentState } from "./editorReducer";

export interface UndoableCommand {
  type: string;
  stateBefore: DocumentState;
  stateAfter: DocumentState;
}

const MAX_STACK_SIZE = 200;
const TEXT_BATCH_DELAY = 400;

export class UndoManager {
  private undoStack: UndoableCommand[] = [];
  private redoStack: UndoableCommand[] = [];

  // Text batching
  private pendingTextBefore: DocumentState | null = null;
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private onCommitPending: (() => void) | null = null;

  // Transaction batching: groups several dispatches into one undo entry so a
  // single logical operation (e.g. paste = delete-then-insert) undoes/redoes
  // atomically. Supports nesting via a depth counter.
  private txDepth = 0;
  private txBefore: DocumentState | null = null;
  private txType = "";

  /** Set a callback to get the current state when committing pending text */
  setCommitCallback(fn: () => DocumentState) {
    this.onCommitPending = () => {
      if (this.pendingTextBefore) {
        const stateAfter = fn();
        // Only record an entry when the document actually changed. A batch can
        // open (handleTextChange) without the model changing — e.g. mid-IME
        // composition, where typeText updates only the view. Pushing a no-op
        // pair here would waste an undo press: undo() commits pending text, then
        // pops that empty entry, so the first Ctrl+Z appears to do nothing.
        // Mirrors the stateBefore !== after guard in endTransaction().
        if (this.pendingTextBefore !== stateAfter) {
          this.pushCommand({
            type: "text",
            stateBefore: this.pendingTextBefore,
            stateAfter,
          });
        }
        this.pendingTextBefore = null;
      }
    };
  }

  /** Call on each text keystroke. Batches into a single undo entry. */
  handleTextChange(currentState: DocumentState) {
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
  push(type: string, stateBefore: DocumentState, stateAfter: DocumentState) {
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
  beginTransaction(type: string, before: DocumentState) {
    if (this.txDepth === 0) {
      this.commitPendingText();
      this.txBefore = before;
      this.txType = type;
    }
    this.txDepth++;
  }

  /** Close the current transaction, pushing one command if the state changed. */
  endTransaction(after: DocumentState) {
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

  undo(): DocumentState | null {
    this.commitPendingText();
    const cmd = this.undoStack.pop();
    if (!cmd) return null;
    this.redoStack.push(cmd);
    return cmd.stateBefore;
  }

  redo(): DocumentState | null {
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
