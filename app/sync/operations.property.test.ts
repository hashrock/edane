import { it, expect } from "vitest";
import fc from "fast-check";
import { modelArb, sequentialIds } from "../domain/model.arb";
import { actionStepArb, initialEditorState, resolveStep } from "../application/editorState.arb";
import { editorReducer } from "../application/editorReducer";
import { applyPatch, buildCommit, diffDocument, parseCommit, type RoomResult, type RoomSnapshot } from "../application/syncOperations";
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

it("buildCommit: applying the commit gives `after`; no change (and no publicity flip) is no commit", () => {
  fc.assert(fc.property(modelArb, fc.array(actionStepArb, { maxLength: 10 }), fc.boolean(), (model, steps, flip) => {
    let state = initialEditorState(model);
    const ids = sequentialIds(), mint = sequentialIds("p");
    for (const step of steps) state = editorReducer(state, resolveStep(step, state, mint), ids);
    const after = state.document.model;
    const commit = buildCommit("c1", model, after);
    if (commit) expect(applyPatch(model, parseCommit(structuredClone(commit)).patch)).toEqual(after);
    else expect(after).toEqual(model);
    expect(buildCommit("c2", after, after)).toBeNull();
    expect(buildCommit("c3", after, after, { before: flip, after: flip })).toBeNull();
    expect(buildCommit("c4", after, after, { before: flip, after: !flip })).toMatchObject({ publicity: { before: flip, after: !flip } });
  }), { numRuns: 200 });
});
