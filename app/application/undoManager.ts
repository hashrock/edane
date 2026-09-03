/**
 * Application layer: command-based undo/redo.
 *
 * Stores before/after DocumentState pairs for each undoable operation.
 * ViewState (selection/caret) is intentionally out of scope: undoing an
 * operation restores the document without moving focus.
 *
 * The bookkeeping is a pure state machine — {@link undoReducer} over
 * {@link UndoState} / {@link UndoEvent} — so every ordering question ("does a
 * structural push close the open text batch first? against which document?")
 * is answered by the event data rather than by which callback happened to
 * run first. {@link UndoManager} is the thin stateful shell the editor holds:
 * it owns the typing debounce timer and the callback that reads the live
 * document, and forwards everything else to the reducer.
 */

import type { DocumentState, UndoType } from "./editorReducer";

/** UndoType plus the one label the manager itself generates (batched text edits). */
export type UndoCommandType = UndoType | "text";

export interface UndoableCommand {
  type: UndoCommandType;
  stateBefore: DocumentState;
  stateAfter: DocumentState;
}

export const MAX_STACK_SIZE = 200;
const TEXT_BATCH_DELAY = 400;

// --- Pure core ---

export interface UndoState {
  undoStack: readonly UndoableCommand[];
  redoStack: readonly UndoableCommand[];
  /**
   * Document as it was before the open typing batch began; null = no batch
   * open. Keystrokes are coalesced into one "text" entry, closed by the next
   * structural event or by the shell's debounce timer.
   */
  pendingTextBefore: DocumentState | null;
  /**
   * Open transaction: several events grouped into one undo entry so a single
   * logical operation (e.g. paste = delete-then-insert) undoes atomically.
   * `depth` supports nesting; only the outermost `end` records. `type` and
   * `before` live together with the depth so that "a transaction is open"
   * is one fact, not two nullable fields callers keep in sync by hand.
   */
  tx: { type: UndoCommandType; before: DocumentState; depth: number } | null;
}

export const initialUndoState: UndoState = {
  undoStack: [],
  redoStack: [],
  pendingTextBefore: null,
  tx: null,
};

export type UndoEvent =
  /**
   * A structural edit went from `before` to `after`. Any open text batch is
   * closed against `before` first — the batch necessarily ended where the
   * structural edit began — so the order in which the editor happens to
   * update its state ref is irrelevant. Absorbed inside a transaction.
   */
  | { type: "push"; undoType: UndoCommandType; before: DocumentState; after: DocumentState }
  /** A keystroke; opens a text batch at `before` unless one is already open. */
  | { type: "textChange"; before: DocumentState }
  /** Close the open text batch against the live document `current`. */
  | { type: "commitText"; current: DocumentState }
  | { type: "begin"; undoType: UndoCommandType; before: DocumentState }
  | { type: "end"; after: DocumentState }
  | { type: "clear" };

/** Append an entry: caps the stack at MAX_STACK_SIZE and discards redo. */
function recordCommand(state: UndoState, cmd: UndoableCommand): UndoState {
  const undoStack = [...state.undoStack, cmd];
  if (undoStack.length > MAX_STACK_SIZE) undoStack.shift();
  return { ...state, undoStack, redoStack: [] };
}

/**
 * Close the open text batch against `current`. Records nothing when the
 * document never changed during the batch (mid-IME typing updates only the
 * view): a no-op pair would waste an undo press.
 */
function closeText(state: UndoState, current: DocumentState): UndoState {
  const before = state.pendingTextBefore;
  if (!before) return state;
  const next = { ...state, pendingTextBefore: null };
  if (before === current) return next;
  return recordCommand(next, { type: "text", stateBefore: before, stateAfter: current });
}

export function undoReducer(state: UndoState, event: UndoEvent): UndoState {
  switch (event.type) {
    case "push": {
      // Inside a transaction every edit is absorbed by its single pair.
      if (state.tx) return state;
      return recordCommand(closeText(state, event.before), {
        type: event.undoType,
        stateBefore: event.before,
        stateAfter: event.after,
      });
    }
    case "textChange": {
      // Typing inside a transaction is covered by the transaction's pair; a
      // batch opened here would otherwise close later, overlapping it.
      if (state.tx) return state;
      if (state.pendingTextBefore) return state;
      return { ...state, pendingTextBefore: event.before };
    }
    case "commitText":
      return closeText(state, event.current);
    case "begin": {
      if (state.tx) return { ...state, tx: { ...state.tx, depth: state.tx.depth + 1 } };
      return {
        ...closeText(state, event.before),
        tx: { type: event.undoType, before: event.before, depth: 1 },
      };
    }
    case "end": {
      const { tx } = state;
      if (!tx) return state;
      if (tx.depth > 1) return { ...state, tx: { ...tx, depth: tx.depth - 1 } };
      const closed = { ...state, tx: null };
      if (tx.before === event.after) return closed;
      return recordCommand(closed, {
        type: tx.type,
        stateBefore: tx.before,
        stateAfter: event.after,
      });
    }
    case "clear":
      return initialUndoState;
  }
}

/**
 * Pop the undo stack: the document to restore, or null when empty. Inside a
 * transaction nothing is popped: the transaction's `before` describes where
 * history stood when it began, and undoing underneath it would make its
 * eventual entry start off the line of history.
 */
function popUndo(state: UndoState): { state: UndoState; restore: DocumentState | null } {
  const cmd = state.undoStack[state.undoStack.length - 1];
  if (!cmd || state.tx) return { state, restore: null };
  return {
    state: {
      ...state,
      undoStack: state.undoStack.slice(0, -1),
      redoStack: [...state.redoStack, cmd],
    },
    restore: cmd.stateBefore,
  };
}

/** Undo from the live document `current`: closes an open text batch, then pops. */
export function undoStep(
  state: UndoState,
  current: DocumentState
): { state: UndoState; restore: DocumentState | null } {
  return popUndo(closeText(state, current));
}

/**
 * Redo from the live document `current`. An open typing batch is closed
 * first: if it changed the document, that edit is new history and discards
 * the redo stack (recording clears it), so there is nothing to redo — typing
 * after an undo forks the timeline, as in any editor. A batch that changed
 * nothing (mid-IME) records nothing and redo proceeds.
 */
export function redoStep(
  state: UndoState,
  current: DocumentState
): { state: UndoState; restore: DocumentState | null } {
  return popRedo(closeText(state, current));
}

/** Pop the redo stack: the document to restore, or null when empty (or mid-transaction, as {@link popUndo}). */
function popRedo(state: UndoState): { state: UndoState; restore: DocumentState | null } {
  const cmd = state.redoStack[state.redoStack.length - 1];
  if (!cmd || state.tx) return { state, restore: null };
  return {
    state: {
      ...state,
      redoStack: state.redoStack.slice(0, -1),
      undoStack: [...state.undoStack, cmd],
    },
    restore: cmd.stateAfter,
  };
}

export function canUndo(state: UndoState): boolean {
  return state.undoStack.length > 0 || state.pendingTextBefore !== null;
}

export function canRedo(state: UndoState): boolean {
  return state.redoStack.length > 0;
}

// --- Stateful shell ---

/**
 * Holds an {@link UndoState} for the editor, plus the two things that can't be
 * pure: the typing debounce timer and the callback that reads the live
 * document (needed when the timer fires, and by undo(), which has no `before`
 * of its own to close the batch against).
 */
export class UndoManager {
  private state: UndoState = initialUndoState;
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private getCurrent: (() => DocumentState) | null = null;

  /** Set a callback to get the current document when committing pending text. */
  setCommitCallback(fn: () => DocumentState) {
    this.getCurrent = fn;
  }

  /** Call on each text keystroke. Batches into a single undo entry. */
  handleTextChange(currentState: DocumentState) {
    this.state = undoReducer(this.state, { type: "textChange", before: currentState });
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = setTimeout(() => this.commitPendingText(), TEXT_BATCH_DELAY);
  }

  /**
   * Commit any pending text batch against the live document. Without a commit
   * callback there is no document to close the batch against, so it stays
   * open (as before).
   */
  commitPendingText() {
    this.cancelTimer();
    if (!this.getCurrent) return;
    this.state = undoReducer(this.state, { type: "commitText", current: this.getCurrent() });
  }

  hasPendingText(): boolean {
    return this.state.pendingTextBefore !== null;
  }

  /** Append a command as-is (no batch closing, no transaction absorption). */
  pushCommand(cmd: UndoableCommand) {
    this.state = recordCommand(this.state, cmd);
  }

  /**
   * Record a structural edit. The open text batch (if any) is closed against
   * `stateBefore` by the reducer — not against the commit callback. The two
   * agree in useNoteEditor, which calls push() before advancing its state
   * ref, but the reducer's rule holds by construction rather than by that
   * call order.
   */
  push(type: UndoCommandType, stateBefore: DocumentState, stateAfter: DocumentState) {
    this.cancelTimer();
    this.state = undoReducer(this.state, {
      type: "push",
      undoType: type,
      before: stateBefore,
      after: stateAfter,
    });
  }

  /**
   * Begin grouping subsequent dispatches into one undo entry. Must be paired
   * with endTransaction(). `before` is the state captured before the group.
   */
  beginTransaction(type: UndoCommandType, before: DocumentState) {
    this.cancelTimer();
    this.state = undoReducer(this.state, { type: "begin", undoType: type, before });
  }

  /** Close the current transaction, pushing one command if the state changed. */
  endTransaction(after: DocumentState) {
    this.state = undoReducer(this.state, { type: "end", after });
  }

  inTransaction(): boolean {
    return this.state.tx !== null;
  }

  undo(): DocumentState | null {
    this.cancelTimer();
    const { state, restore } = this.getCurrent
      ? undoStep(this.state, this.getCurrent())
      : popUndo(this.state);
    this.state = state;
    return restore;
  }

  redo(): DocumentState | null {
    this.cancelTimer();
    const { state, restore } = this.getCurrent
      ? redoStep(this.state, this.getCurrent())
      : popRedo(this.state);
    this.state = state;
    return restore;
  }

  canUndo(): boolean {
    return canUndo(this.state);
  }

  canRedo(): boolean {
    return canRedo(this.state);
  }

  clear() {
    this.cancelTimer();
    this.state = initialUndoState;
  }

  private cancelTimer() {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
  }
}
