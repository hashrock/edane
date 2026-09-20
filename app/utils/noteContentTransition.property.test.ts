/**
 * Property-based tests for the per-request storage decision of a note PATCH.
 * The input space is tiny (publicity before/after × content or not), so this
 * is close to exhaustive; the properties are the policy from the module doc,
 * stated independently of the branch order in the implementation:
 *  - plaintext is stored only when the note ends up public,
 *  - encryption only when it ends up private,
 *  - nothing happens only when neither content nor publicity changes,
 *  - the content acted on is the incoming one, else the stored one.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { resolveNoteContentAction } from "./noteContentTransition";

const paramsArb = fc.record({
  currentIsPublic: fc.boolean(),
  currentContent: fc.string({ maxLength: 20 }),
  requestedIsPublic: fc.constantFrom(undefined, true, false),
  requestedContent: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
});

describe("resolveNoteContentAction", () => {
  it("follows the storage policy for every combination", () => {
    fc.assert(
      fc.property(paramsArb, (p) => {
        const action = resolveNoteContentAction(p);
        const nextIsPublic = p.requestedIsPublic ?? p.currentIsPublic;
        const contentChanges = p.requestedContent !== undefined;
        const publicityChanges = nextIsPublic !== p.currentIsPublic;

        expect(action.kind === "unchanged").toBe(!contentChanges && !publicityChanges);
        if (action.kind === "unchanged") return;

        expect(action.content).toBe(p.requestedContent ?? p.currentContent);
        switch (action.kind) {
          case "store-plain":
            expect(nextIsPublic).toBe(true);
            expect(contentChanges).toBe(true);
            break;
          case "encrypt":
            expect(nextIsPublic).toBe(false);
            break;
          case "decrypt-if-encrypted":
            expect(nextIsPublic).toBe(true);
            expect(contentChanges).toBe(false);
            break;
        }
      })
    );
  });
});
