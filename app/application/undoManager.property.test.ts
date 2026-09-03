/**
 * Property-based tests for the undo state machine.
 *
 * 1. Reference comparison: an editor-shaped op sequence (structural pushes,
 *    typing batches, nested transactions) is translated to events and run
 *    through `undoReducer`; the entries a user expects to undo through are
 *    computed independently and must match, oldest first, both on the way
 *    back (undo) and forward (redo). The same ops are then replayed through
 *    the `UndoManager` shell, which must produce exactly the core's answer.
 *
 * 2. Invariants over ARBITRARY event orderings. Since the order in which the
 *    editor pushes, commits text, begins/ends transactions and undoes is
 *    now event data, a random driver can interleave them freely; for every
 *    prefix the stack must stay capped, a push must clear redo, transactions
 *    must absorb everything inside them, and — the property that makes undo
 *    walk a single line of history — consecutive entries must chain: each
 *    entry's `before` is the previous entry's `after`, and what undo restores
 *    is exactly the top entry's `before`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import {
  canRedo,
  canUndo,
  initialUndoState,
  MAX_STACK_SIZE,
  redoStep,
  UndoManager,
  undoReducer,
  undoStep,
  type UndoEvent,
  type UndoState,
} from "./undoManager";
import type { DocumentState } from "./editorReducer";

// Entries are compared by identity (that's what the machine does), so each
// document is a fresh object; the model inside is irrelevant.
let seq = 0;
const fresh = (): DocumentState => ({
  model: { id: `s${seq++}`, text: "", children: [] },
  clipboard: null,
});

// --- 1. Editor-shaped sequences vs. a reference model ---

type Op =
  | { op: "push" }
  | { op: "text"; keystrokes: number; changes: boolean }
  | { op: "tx"; inner: Op[]; changes: boolean };

const opArb: fc.Arbitrary<Op> = fc.letrec<{ op: Op }>((tie) => ({
  op: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.constant({ op: "push" } as Op),
    fc.record({ op: fc.constant("text" as const), keystrokes: fc.integer({ min: 1, max: 4 }), changes: fc.boolean() }),
    fc.record({ op: fc.constant("tx" as const), inner: fc.array(tie("op"), { maxLength: 3 }), changes: fc.boolean() })
  ),
})).op;

/**
 * What a user expects to undo through, oldest first, plus the event stream
 * the editor would emit. A typing batch is closed by the next structural
 * event against the document as it stood right then; a batch that never
 * changed the document records nothing, nor does a transaction that ends on
 * the state it started from. Anything inside a transaction is absorbed.
 */
interface Ref {
  state: DocumentState;
  pendingText: DocumentState | null;
  expected: Array<[DocumentState, DocumentState]>;
  events: UndoEvent[];
}

function flushText(ref: Ref) {
  if (ref.pendingText && ref.pendingText !== ref.state) {
    ref.expected.push([ref.pendingText, ref.state]);
  }
  ref.pendingText = null;
}

function play(ops: Op[], ref: Ref, depth = 0): void {
  for (const op of ops) {
    switch (op.op) {
      case "push": {
        const before = ref.state;
        const after = fresh();
        if (depth === 0) flushText(ref);
        ref.events.push({ type: "push", undoType: "add-child", before, after });
        ref.state = after;
        if (depth === 0) ref.expected.push([before, after]);
        break;
      }
      case "text": {
        for (let i = 0; i < op.keystrokes; i++) {
          ref.events.push({ type: "textChange", before: ref.state });
          if (depth === 0 && !ref.pendingText) ref.pendingText = ref.state;
          if (op.changes) ref.state = fresh();
        }
        break;
      }
      case "tx": {
        const before = ref.state;
        if (depth === 0) flushText(ref);
        ref.events.push({ type: "begin", undoType: "paste", before });
        play(op.inner, ref, depth + 1);
        if (op.changes) ref.state = fresh();
        ref.events.push({ type: "end", after: ref.state });
        if (depth === 0 && before !== ref.state) ref.expected.push([before, ref.state]);
        break;
      }
    }
  }
}

function walkBack(state: UndoState, current: DocumentState): { undone: DocumentState[]; state: UndoState } {
  const undone: DocumentState[] = [];
  for (;;) {
    const step = undoStep(state, current);
    state = step.state;
    if (!step.restore) return { undone, state };
    undone.push(step.restore);
    current = step.restore;
  }
}

function walkForward(state: UndoState, current: DocumentState): { redone: DocumentState[]; state: UndoState } {
  const redone: DocumentState[] = [];
  for (;;) {
    const step = redoStep(state, current);
    state = step.state;
    if (!step.restore) return { redone, state };
    redone.push(step.restore);
    current = step.restore;
  }
}

describe("undoReducer vs. reference model", () => {
  it("undo returns the befores in reverse, redo the afters in order; both end empty", () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 12 }), (ops) => {
        const ref: Ref = { state: fresh(), pendingText: null, expected: [], events: [] };
        play(ops, ref);
        const state = ref.events.reduce(undoReducer, initialUndoState);
        expect(state.tx).toBeNull();
        // The first undo closes whatever batch is still open.
        flushText(ref);

        const back = walkBack(state, ref.state);
        expect(back.undone).toEqual(ref.expected.map(([before]) => before).reverse());
        expect(canUndo(back.state)).toBe(false);

        const forward = walkForward(back.state, back.undone[back.undone.length - 1] ?? ref.state);
        expect(forward.redone).toEqual(ref.expected.map(([, after]) => after));
        expect(canRedo(forward.state)).toBe(false);
      })
    );
  });
});

// --- 2. Arbitrary event orderings ---

type Drive =
  | { kind: "push" }
  | { kind: "type"; changes: boolean }
  | { kind: "commit" }
  | { kind: "begin" }
  | { kind: "end"; changes: boolean }
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "clear" };

const driveArb: fc.Arbitrary<Drive> = fc.oneof(
  fc.constant({ kind: "push" } as Drive),
  fc.record({ kind: fc.constant("type" as const), changes: fc.boolean() }),
  fc.constant({ kind: "commit" } as Drive),
  fc.constant({ kind: "begin" } as Drive),
  fc.record({ kind: fc.constant("end" as const), changes: fc.boolean() }),
  fc.constant({ kind: "undo" } as Drive),
  fc.constant({ kind: "redo" } as Drive),
  fc.constant({ kind: "clear" } as Drive)
);

/** Each entry starts where the previous one ended (a single line of history). */
function expectChained(entries: readonly { stateBefore: DocumentState; stateAfter: DocumentState }[], trail: string) {
  for (let i = 1; i < entries.length; i++) {
    expect(entries[i].stateBefore, `chain break at ${i} after ${trail}`).toBe(entries[i - 1].stateAfter);
  }
}

describe("undoReducer invariants under arbitrary event orderings", () => {
  it("caps the stack, clears redo on push, absorbs everything inside a transaction, keeps history chained", () => {
    fc.assert(
      fc.property(fc.array(driveArb, { maxLength: 40 }), (drives) => {
        let state = initialUndoState;
        // The driver is the editor: its document only moves on an edit, a
        // transaction end, or a restore.
        let current = fresh();
        const trail: string[] = [];
        for (const d of drives) {
          trail.push(d.kind);
          const prev = state;
          switch (d.kind) {
            case "push": {
              const after = fresh();
              state = undoReducer(state, { type: "push", undoType: "add-child", before: current, after });
              if (prev.tx) {
                expect(state, `absorbed push after ${trail}`).toBe(prev);
              } else {
                expect(state.redoStack, `redo after push ${trail}`).toEqual([]);
                expect(state.undoStack[state.undoStack.length - 1].stateAfter).toBe(after);
              }
              current = after;
              break;
            }
            case "type": {
              state = undoReducer(state, { type: "textChange", before: current });
              if (prev.tx) expect(state, `absorbed typing after ${trail}`).toBe(prev);
              if (d.changes) current = fresh();
              break;
            }
            case "commit":
              state = undoReducer(state, { type: "commitText", current });
              expect(state.pendingTextBefore).toBeNull();
              break;
            case "begin":
              state = undoReducer(state, { type: "begin", undoType: "paste", before: current });
              expect(state.tx).not.toBeNull();
              expect(state.pendingTextBefore).toBeNull();
              break;
            case "end": {
              // Only an open transaction can end on a changed document.
              if (d.changes && prev.tx) current = fresh();
              state = undoReducer(state, { type: "end", after: current });
              if (!prev.tx) expect(state, `end without begin after ${trail}`).toBe(prev);
              break;
            }
            case "undo": {
              const { state: next, restore } = undoStep(state, current);
              const closed = undoReducer(state, { type: "commitText", current });
              const top = closed.undoStack[closed.undoStack.length - 1];
              // Mid-transaction undo is absorbed like every other edit.
              const expected = prev.tx ? null : (top?.stateBefore ?? null);
              expect(restore, `undo restores top.before after ${trail}`).toBe(expected);
              state = next;
              if (restore) current = restore;
              break;
            }
            case "redo": {
              const { state: next, restore } = redoStep(state, current);
              // Typing since the undo forks history: the batch is recorded
              // and the redo stack is gone.
              const closed = undoReducer(state, { type: "commitText", current });
              const top = closed.redoStack[closed.redoStack.length - 1];
              const expected = prev.tx ? null : (top?.stateAfter ?? null);
              expect(restore, `redo restores top.after after ${trail}`).toBe(expected);
              state = next;
              if (restore) current = restore;
              break;
            }
            case "clear":
              state = undoReducer(state, { type: "clear" });
              expect(state).toBe(initialUndoState);
              break;
          }
          expect(state.undoStack.length).toBeLessThanOrEqual(MAX_STACK_SIZE);
          expectChained(state.undoStack, trail.join(" "));
          // Redo entries continue the line from the undo stack's top.
          const line = [...state.undoStack, ...[...state.redoStack].reverse()];
          expectChained(line, `${trail.join(" ")} (with redo)`);
          // An open batch also starts where history currently ends.
          const top = state.undoStack[state.undoStack.length - 1];
          if (state.pendingTextBefore && top) {
            expect(state.pendingTextBefore, `batch start after ${trail}`).toBe(top.stateAfter);
          }
        }
      }),
      { numRuns: 300 }
    );
  });

  it("never keeps more than MAX_STACK_SIZE entries, dropping the oldest", () => {
    fc.assert(
      fc.property(fc.integer({ min: MAX_STACK_SIZE - 10, max: MAX_STACK_SIZE + 30 }), (pushes) => {
        let state = initialUndoState;
        let current = fresh();
        const afters: DocumentState[] = [];
        for (let i = 0; i < pushes; i++) {
          const after = fresh();
          state = undoReducer(state, { type: "push", undoType: "add-child", before: current, after });
          afters.push(after);
          current = after;
        }
        expect(state.undoStack.length).toBe(Math.min(pushes, MAX_STACK_SIZE));
        expect(state.undoStack.map((c) => c.stateAfter)).toEqual(afters.slice(-MAX_STACK_SIZE));
      }),
      { numRuns: 20 }
    );
  });
});

// --- The shell is the core plus a timer ---

describe("UndoManager shell ≡ undoReducer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("replaying the same editor sequence through the class yields the core's undo/redo answer", () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 12 }), fc.boolean(), (ops, letTimerFire) => {
        const ref: Ref = { state: fresh(), pendingText: null, expected: [], events: [] };
        play(ops, ref);
        const core = ref.events.reduce(undoReducer, initialUndoState);

        const um = new UndoManager();
        const live = { doc: ref.state };
        um.setCommitCallback(() => live.doc);
        // Replay: the shell's API is one method per event.
        for (const e of ref.events) {
          switch (e.type) {
            case "push":
              um.push(e.undoType, e.before, e.after);
              break;
            case "textChange":
              um.handleTextChange(e.before);
              break;
            case "begin":
              um.beginTransaction(e.undoType, e.before);
              break;
            case "end":
              um.endTransaction(e.after);
              break;
            default:
              throw new Error(`unexpected ${e.type}`);
          }
        }
        // The debounce timer closes the batch against the live document —
        // exactly what the first undo() would do — so it must not change
        // the answer.
        if (letTimerFire) vi.advanceTimersByTime(1000);

        // The editor applies each restore, so the live document follows.
        const undone: DocumentState[] = [];
        for (let s = um.undo(); s; s = um.undo()) {
          undone.push(s);
          live.doc = s;
        }
        const back = walkBack(core, ref.state);
        expect(undone).toEqual(back.undone);
        expect(um.canUndo()).toBe(false);
        const afterUndo = live.doc;

        const redone: DocumentState[] = [];
        for (let s = um.redo(); s; s = um.redo()) {
          redone.push(s);
          live.doc = s;
        }
        expect(redone).toEqual(walkForward(back.state, afterUndo).redone);
        expect(um.canRedo()).toBe(false);
      })
    );
  });
});
