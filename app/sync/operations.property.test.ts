import { it, expect } from "vitest";
import fc from "fast-check";
import { modelArb, sequentialIds } from "../domain/model.arb";
import { actionStepArb, initialEditorState, resolveStep } from "../application/editorState.arb";
import { editorReducer } from "../application/editorReducer";
import { applyPatch, diffDocument, parseCommit, type RoomResult, type RoomSnapshot } from "../application/syncOperations";
// NoteRoom is reached over Durable Object RPC, which structured-clones arguments and
// results: every patch and every snapshot result must survive that hop unchanged.
it("transports every reducer action through validated operations without losing fields", () => {
  fc.assert(fc.property(modelArb, fc.array(actionStepArb, { maxLength: 25 }), (model, steps) => {
    let state = initialEditorState(model);
    const ids = sequentialIds(), mint = sequentialIds("p");
    for (const step of steps) {
      const next = editorReducer(state, resolveStep(step, state, mint), ids);
      const patch = structuredClone(diffDocument(state.document.model, next.document.model));
      parseCommit({ id: "property", patch });
      expect(applyPatch(state.document.model, patch)).toEqual(next.document.model);
      state = next;
    }
  }), { numRuns: 200 });
});

it("snapshot results survive the RPC hop", () => {
  fc.assert(fc.property(modelArb, fc.nat(), fc.boolean(), (model, version, isPublic) => {
    const result: RoomResult<RoomSnapshot> = { ok: true, value: { model, version, isPublic, updatedAt: "2026-10-22T00:00:00.000Z" } };
    expect(structuredClone(result)).toEqual(result);
  }));
});
