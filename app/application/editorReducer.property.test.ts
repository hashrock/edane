/**
 * Property-based tests for editorReducer.
 *
 * 1. The focus invariant — "exactly ONE node is always active" (module doc
 *    of editorReducer.ts): the active node always exists and is visible, and
 *    the document always has a top-level node — checked along RANDOM action
 *    sequences on random trees, one entry per EditorAction variant. The
 *    generator (`actionStepArb` / `resolveStep`) lives in editorState.arb.ts
 *    so other machines driven by the same actions — e.g. the read-only guard
 *    — are exercised by exactly the same sequences.
 *
 * 2. The canvas ↑/↓ rule from CLAUDE.md: a dead end depends only on where the
 *    node sits in the tree (the trailing edge for ↓, the first top-level node
 *    for ↑), never on history; ↓ never descends into children; and ← / →
 *    round-trip through the parent.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  findNode,
  findParentAndIndex,
  getFlatOrder,
  isTopLevel,
  type MindMapModel,
} from "../domain/model";
import { modelAndVisibleArb, modelArb, nodeArb, sequentialIds } from "../domain/model.arb";
import { pasteCommand, type PasteSource } from "./editorCommands";
import { editorReducer, reconcileView, type EditorState } from "./editorReducer";
import {
  actionStepArb,
  editorStateAt,
  expectFocusInvariant,
  initialEditorState,
  onTrailingEdge,
  resolveStep,
  type ActionStep,
} from "./editorState.arb";

describe("editorReducer along random action sequences", () => {
  it("keeps the active node existing & visible, ids unique and a top-level node present — and is a pure function of its inputs", () => {
    fc.assert(
      fc.property(modelArb, fc.array(actionStepArb, { maxLength: 25 }), (model, steps) => {
        // With ids supplied from outside the whole run is deterministic, so
        // running it twice must end in the same state: the reducer keeps no
        // hidden state and never depends on anything but its arguments. The
        // invariant is checked on the first pass only.
        const run = (check: boolean): EditorState => {
          let state = initialEditorState(model);
          const nextId = sequentialIds();
          const mint = sequentialIds("p");
          const trail: string[] = [];
          if (check) expectFocusInvariant(state, "init");
          for (const step of steps) {
            const action = resolveStep(step, state, mint);
            trail.push(action.type);
            state = editorReducer(state, action, nextId);
            if (check) expectFocusInvariant(state, trail.join(" → "));
          }
          return state;
        };
        const first = run(true);
        expect(run(false)).toEqual(first);
      }),
      { numRuns: 300 }
    );
  });
});

function selecting(model: MindMapModel, nodeId: string): EditorState {
  const s = initialEditorState(model);
  return editorReducer(s, {
    type: "activateNode",
    nodeId,
    cursorPos: 0,
    selectionEnd: 0,
    editing: false,
  });
}

/**
 * withCaretInBuffer now bounds every caret the reducer returns, so "the caret
 * stays inside the text" is structural and would pass here for free. What is
 * NOT structural is *where* the caret lands: deleteAtEnd promises the join, and
 * any reported position at or past the end of the node has to mean that same
 * place — which is the contract the #147 soak failure was really about. `max`
 * stays near the generated text lengths so both sides of deleteAtEnd's "is the
 * caret at the end?" guard get sampled.
 */
describe("deleteAtEnd against a caret the model cannot vouch for", () => {
  it("lands the caret on the join for any reported position at or past the end", () => {
    fc.assert(
      fc.property(modelAndVisibleArb, fc.nat({ max: 20 }), ({ model, nodeId }, pos) => {
        const before = findNode(model, nodeId)!.text;
        fc.pre(pos >= before.length);
        const state = editorStateAt(model, nodeId, { editing: true });
        const next = editorReducer(state, { type: "deleteAtEnd", pos });
        fc.pre(next !== state); // no successor to merge: nothing to say
        expect(next.view.editingText).toBe(findNode(next.document.model, nodeId)!.text);
        expect(next.view.cursorPos).toBe(before.length);
        expect(next.view.selectionEnd).toBe(before.length);
      })
    );
  });
});

/**
 * The other half of the fix, and the one the caret bound does not imply: the
 * buffer has to keep describing the document. `editingText` IS the textarea's
 * value, so a buffer that drifts from the model is text the user can see and
 * commit back (typeText sends the whole buffer) — which is how undo used to
 * revert itself. The single exception is an uncommitted IME composition, where
 * the buffer is *meant* to run ahead; it is sticky (nothing re-reads the buffer
 * until an action focuses a node), so the check stops at the first one rather
 * than resuming after it.
 */
describe("the edit buffer follows the document", () => {
  it("editingText is the active node's text until an uncommitted IME step", () => {
    fc.assert(
      fc.property(modelArb, fc.array(actionStepArb, { maxLength: 25 }), (model, steps) => {
        let state = initialEditorState(model);
        const nextId = sequentialIds();
        const mint = sequentialIds("p");
        const trail: string[] = [];
        for (const step of steps) {
          const action = resolveStep(step, state, mint);
          trail.push(action.type);
          state = editorReducer(state, action, nextId);
          if (action.type === "typeText" && !action.commitModel) return;
          const node = findNode(state.document.model, state.view.activeNodeId!);
          expect(state.view.editingText, `buffer after ${trail.join(" → ")}`).toBe(
            node!.text
          );
        }
      }),
      { numRuns: 300 }
    );
  });
});

/**
 * reconcileView is the one place a view meets a document it was not derived
 * from (undo/redo). Whatever it lands on, the view it returns must describe
 * that document: the buffer is the node's text, and the caret is inside it.
 * Stated over an arbitrary INCOMPATIBLE view — a caret and a buffer drawn
 * independently of the model — because that is exactly what a document swap
 * hands it.
 */
describe("reconcileView leaves no view describing the old document", () => {
  it("returns a buffer that is the active node's text, with the caret inside it", () => {
    fc.assert(
      fc.property(
        modelArb,
        fc.string({ maxLength: 8 }),
        fc.nat({ max: 20 }),
        fc.nat({ max: 20 }),
        fc.boolean(),
        (model, buffer, pos, sel, editing) => {
          const stale: EditorState["view"] = {
            ...initialEditorState(model).view,
            editing,
            editingText: buffer,
            cursorPos: pos,
            selectionEnd: sel,
          };
          const view = reconcileView(stale, { model, clipboard: null });
          const active = findNode(model, view.activeNodeId!);
          expect(active).not.toBeNull();
          expect(view.editingText).toBe(active!.text);
          expect(view.cursorPos).toBeLessThanOrEqual(view.editingText.length);
          expect(view.selectionEnd).toBeLessThanOrEqual(view.editingText.length);
        }
      )
    );
  });
});

describe("selection-mode ↑/↓ (sibling-first) is decided by tree position only", () => {
  it("↓ dead-ends exactly on the trailing edge, otherwise lands outside the subtree on the next sibling-or-ancestor's-sibling", () => {
    fc.assert(
      fc.property(modelAndVisibleArb, ({ model, nodeId }) => {
        const state = selecting(model, nodeId);
        const next = editorReducer(state, { type: "moveDownSiblingFirst" });
        const stuck = next.view.activeNodeId === nodeId;
        expect(stuck).toBe(onTrailingEdge(model, nodeId));
        if (stuck) return;
        const landed = next.view.activeNodeId!;
        // Never a descendant …
        expect(findNode(findNode(model, nodeId)!, landed)).toBeNull();
        // … and exactly the first following sibling found walking up.
        let expected: string | undefined;
        for (let info = findParentAndIndex(model, nodeId); info && !expected; info = findParentAndIndex(model, info.parent.id)) {
          expected = info.parent.children[info.index + 1]?.id;
        }
        expect(landed).toBe(expected);
      })
    );
  });

  it("↑ dead-ends only on the first top-level node, otherwise lands on the previous sibling or the parent", () => {
    fc.assert(
      fc.property(modelAndVisibleArb, ({ model, nodeId }) => {
        const state = selecting(model, nodeId);
        const next = editorReducer(state, { type: "moveUpSiblingFirst" });
        const info = findParentAndIndex(model, nodeId)!;
        const stuck = next.view.activeNodeId === nodeId;
        expect(stuck).toBe(isTopLevel(model, nodeId) && info.index === 0);
        if (stuck) return;
        const expected = info.index > 0 ? info.parent.children[info.index - 1].id : info.parent.id;
        expect(next.view.activeNodeId).toBe(expected);
      })
    );
  });

  it("← then → returns to the node you left (for any nested visible node)", () => {
    fc.assert(
      fc.property(modelAndVisibleArb, ({ model, nodeId }) => {
        fc.pre(!isTopLevel(model, nodeId));
        const state = selecting(model, nodeId);
        const up = editorReducer(state, { type: "moveToParent" });
        expect(up.view.activeNodeId).toBe(findParentAndIndex(model, nodeId)!.parent.id);
        const back = editorReducer(up, { type: "moveToChild" });
        expect(back.view.activeNodeId).toBe(nodeId);
      })
    );
  });
});

// --- Commands: the real multi-step sequences the components run ---

/** An outline-ish plain text: lines with 0–2 levels of indentation. */
const indentedTextArb = fc
  .array(fc.tuple(fc.nat({ max: 2 }), fc.string({ maxLength: 6 })), { maxLength: 4 })
  .map((ls) => ls.map(([d, t]) => "  ".repeat(d) + t).join("\n"));

/** A small Markdown document: bullets at 0–2 levels, some as tasks. */
const markdownArb = fc
  .array(
    fc.tuple(fc.nat({ max: 2 }), fc.constantFrom("", "[ ] ", "[x] "), fc.stringMatching(/^[a-z0-9 ]{0,6}$/)),
    { maxLength: 4 }
  )
  .map((ls) => ls.map(([d, box, t]) => `${"  ".repeat(d)}- ${box}${t}`).join("\n"));

const pasteSourceArb: fc.Arbitrary<PasteSource> = fc.oneof(
  indentedTextArb.map((text) => ({ kind: "text", text }) as PasteSource),
  fc
    .tuple(markdownArb, fc.constantFrom("decompose", "node", "plain") as fc.Arbitrary<"decompose" | "node" | "plain">)
    .map(([text, mode]) => ({ kind: "markdown", text, mode }) as PasteSource),
  fc.option(nodeArb, { nil: undefined }).map((node) => ({ kind: "branch", node }) as PasteSource)
);

type SeqStep = { kind: "action"; step: ActionStep } | { kind: "paste"; source: PasteSource };
const seqStepArb: fc.Arbitrary<SeqStep> = fc.oneof(
  actionStepArb.map((step) => ({ kind: "action", step }) as SeqStep),
  pasteSourceArb.map((source) => ({ kind: "paste", source }) as SeqStep)
);

describe("paste commands interleaved with actions", () => {
  it("keep the focus invariant at every step, end in selection mode, and every pasted node is visible", () => {
    fc.assert(
      fc.property(modelArb, fc.array(seqStepArb, { maxLength: 20 }), (model, steps) => {
        let state = initialEditorState(model);
        const nextId = sequentialIds();
        const mint = sequentialIds("p");
        const trail: string[] = [];
        for (const s of steps) {
          if (s.kind === "action") {
            const action = resolveStep(s.step, state, mint);
            trail.push(action.type);
            state = editorReducer(state, action, nextId);
            expectFocusInvariant(state, trail.join(" → "));
            continue;
          }
          // Node pastes only happen in selection mode (planPaste turns a paste
          // while editing into plain text at the caret), so the sequence is
          // only meaningful there.
          if (state.view.editing) continue;
          const effects = pasteCommand(state, s.source, { nextId: mint });
          trail.push(`paste:${s.source.kind}`);
          // null = nothing to paste (blank text, empty internal clipboard).
          if (!effects) continue;
          let flashed: string[] | "active" = [];
          for (const f of effects) {
            if (f.kind === "flash") flashed = f.ids;
            if (f.kind !== "dispatch") continue;
            state = editorReducer(state, f.action, nextId);
            expectFocusInvariant(state, trail.join(" → ") + ` [${f.action.type}]`);
          }
          const visible = getFlatOrder(state.document.model);
          if (flashed !== "active") {
            expect(state.view.editing, `edit mode after ${trail.join(" → ")}`).toBe(false);
            for (const id of flashed) {
              expect(visible, `pasted node hidden after ${trail.join(" → ")}`).toContain(id);
            }
          }
        }
      }),
      { numRuns: 300 }
    );
  });
});
