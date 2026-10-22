import { it, expect } from "vitest";
import fc from "fast-check";
import { allIds, modelArb, pick } from "../domain/model.arb";
import { initialEditorState } from "./editorState.arb";
import { prepareActions } from "./agentActions";

/** A valid apply_note action against the document's existing nodes. */
const validActionArb = fc.oneof(
  fc.record({ kind: fc.constant("setNodeContent" as const), i: fc.nat(), text: fc.string({ maxLength: 8 }) }),
  fc.record({ kind: fc.constant("setChecked" as const), i: fc.nat(), checked: fc.constantFrom(true, false, null) }),
  fc.record({ kind: fc.constant("addChild" as const), i: fc.nat() }),
  fc.record({ kind: fc.constant("setTitle" as const), text: fc.string({ maxLength: 8 }) })
);
const badActionArb = fc.oneof(
  fc.constant({ type: "noSuchAction" }),
  fc.constant({ type: "setTitle", text: "t", colour: "red" }),
  fc.constant({ type: "setNodeContent", nodeId: "ghost", text: "x" }),
  fc.constant({ type: "setTitle", text: 42 })
);

it("applies all of a valid batch or none of an invalid one, without taking over the view", () => {
  fc.assert(
    fc.property(
      modelArb,
      fc.array(validActionArb, { minLength: 1, maxLength: 6 }),
      fc.option(fc.tuple(badActionArb, fc.nat())),
      (model, steps, bad) => {
        const state = initialEditorState(model);
        const ids = allIds(model);
        // Only nodes of the original document, so every action stays valid in sequence
        // (addChild never removes one).
        const actions: Record<string, unknown>[] = steps.map((s) =>
          s.kind === "setTitle" ? { type: "setTitle", text: s.text }
          : s.kind === "setNodeContent" ? { type: s.kind, nodeId: pick(ids, s.i), text: s.text }
          : s.kind === "setChecked" ? { type: s.kind, nodeId: pick(ids, s.i), checked: s.checked }
          : { type: s.kind, nodeId: pick(ids, s.i) }
        );
        const snapshot = structuredClone(state);
        if (bad) {
          const [action, at] = bad;
          actions.splice(at % (actions.length + 1), 0, action);
          expect(() => prepareActions(state, { actions })).toThrow();
          expect(state).toEqual(snapshot); // nothing applied, input untouched
          return;
        }
        const next = prepareActions(state, { actions });
        expect(state).toEqual(snapshot);
        expect(next.view.activeNodeId).toBe(state.view.activeNodeId);
        expect(next.view.editing).toBe(state.view.editing);
      }
    ),
    { numRuns: 200 }
  );
});
