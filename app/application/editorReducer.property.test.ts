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
import { editorReducer, type EditorState } from "./editorReducer";
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
 * The caret a text action reports is a position in the TEXTAREA, which is not
 * always a position in the model (see deleteAtEnd in editorReducer.ts). The
 * sequence property above states the same bound — it is expectFocusInvariant's
 * caret clause — but only draws the document swap next to the delete, on a node
 * that has a successor to merge, after tens of thousands of runs: a soak found
 * it at 350x, 1000x and 1600x, each on a different seed, while the normal 300
 * let it through. Stating the bound over the reported caret directly costs a
 * handful of runs. `max` stays near the generated text lengths so both sides of
 * deleteAtEnd's "is the caret at the end?" guard get sampled.
 */
describe("deleteAtEnd against a caret the model cannot vouch for", () => {
  it("never leaves the caret outside the text it is a caret into", () => {
    fc.assert(
      fc.property(modelAndVisibleArb, fc.nat({ max: 20 }), ({ model, nodeId }, pos) => {
        const state = editorStateAt(model, nodeId, { editing: true });
        const next = editorReducer(state, { type: "deleteAtEnd", pos });
        const len = next.view.editingText.length;
        expect(next.view.cursorPos).toBeLessThanOrEqual(len);
        expect(next.view.selectionEnd).toBeLessThanOrEqual(len);
      })
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
