/**
 * Property-based tests for the schema editor's draft list: reordering and
 * removal never invent, drop or duplicate rows (rid is the row's identity),
 * and a move is undone by the opposite move.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { DRAFT_KINDS, moveField, removeField, type DraftField } from "./schemaDraft";

const draftArb: fc.Arbitrary<DraftField[]> = fc
  .array(fc.record({ key: fc.string({ maxLength: 4 }), kind: fc.constantFrom(...DRAFT_KINDS) }), { maxLength: 8 })
  .map((rows) => rows.map((r, i) => ({ ...r, rid: `r${i}` })));

const rids = (d: DraftField[]) => d.map((r) => r.rid);

describe("schemaDraft (property)", () => {
  it("moveField permutes the rows and moves the target by exactly one slot", () => {
    fc.assert(
      fc.property(draftArb, fc.nat(9), fc.constantFrom<-1 | 1>(-1, 1), (draft, pick, dir) => {
        const rid = `r${pick}`;
        const moved = moveField(draft, rid, dir);
        expect(rids(moved).sort()).toEqual(rids(draft).sort());
        const i = rids(draft).indexOf(rid);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= draft.length) expect(moved).toBe(draft);
        else {
          expect(rids(moved).indexOf(rid)).toBe(j);
          expect(moveField(moved, rid, dir === 1 ? -1 : 1)).toEqual(draft);
        }
      })
    );
  });

  it("removeField drops exactly the named row and keeps the order of the rest", () => {
    fc.assert(
      fc.property(draftArb, fc.nat(9), (draft, pick) => {
        const rid = `r${pick}`;
        expect(rids(removeField(draft, rid))).toEqual(rids(draft).filter((r) => r !== rid));
      })
    );
  });
});
