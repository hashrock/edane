import { it, expect } from "vitest";
import fc from "fast-check";
import { modelArb, sequentialIds } from "../domain/model.arb";
import { actionStepArb, initialEditorState, resolveStep } from "../application/editorState.arb";
import { editorReducer } from "../application/editorReducer";
import { applyPatch, diffDocument, parseCommit } from "../application/syncOperations";
it("transports every reducer action through validated operations without losing fields", () => {
  fc.assert(fc.property(modelArb, fc.array(actionStepArb, { maxLength: 25 }), (model, steps) => {
    let state = initialEditorState(model);
    const ids = sequentialIds(), mint = sequentialIds("p");
    for (const step of steps) {
      const next = editorReducer(state, resolveStep(step, state, mint), ids);
      const patch = diffDocument(state.document.model, next.document.model);
      parseCommit({ id: "property", patch });
      expect(applyPatch(state.document.model, patch)).toEqual(next.document.model);
      state = next;
    }
  }), { numRuns: 200 });
});
