import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  addField,
  blankField,
  draftErrors,
  DRAFT_KINDS,
  fromDraft,
  moveField,
  removeField,
  ridSource,
  toDraft,
  updateField,
  type DraftField,
} from "./schemaDraft";
import { formatSchema, parseSchema } from "../domain/branchSchema";

const parsed = (text: string) => {
  const p = parseSchema(text);
  if (!p.ok) throw new Error(p.error);
  return p.schema;
};

describe("schemaDraft", () => {
  it("round-trips a schema through the draft", () => {
    const text = "author, cover:image, done:check, on:date";
    expect(formatSchema(fromDraft(toDraft(parsed(text), ridSource())))).toBe(text);
  });

  it("adds, edits, moves and removes rows", () => {
    const rid = ridSource();
    let d = toDraft(parsed("a, b, c"), rid); // f0 f1 f2
    d = moveField(d, "f2", -1);
    d = updateField(d, "f0", { kind: "image" });
    d = addField(d, blankField(rid));
    d = updateField(d, "f3", { key: "z", kind: "date" });
    d = removeField(d, "f1");
    expect(formatSchema(fromDraft(d))).toBe("a:image, c, z:date");
    expect(moveField(d, "f0", -1)).toBe(d);
  });

  it("reports empty, invalid, reserved and duplicate keys", () => {
    const d: DraftField[] = [
      ...toDraft(parsed("a"), ridSource()),
      { ...blankField(() => "e1") },
      { ...blankField(() => "e2"), key: "a" },
      { ...blankField(() => "e3"), key: "title" },
      { ...blankField(() => "e4"), key: "1x" },
    ];
    expect([...draftErrors(d).keys()]).toEqual(["e1", "e2", "e3", "e4"]);
  });

  it("a draft has no errors exactly when its text form parses back to the same schema", () => {
    const rowArb = fc.record({
      key: fc.constantFrom("", "a", "b", "title", "1x", "ok_1"),
      kind: fc.constantFrom(...DRAFT_KINDS),
    });
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 5 }), (rows) => {
        const draft = rows.map((r, i) => ({ ...r, rid: `r${i}` }));
        const schema = fromDraft(draft);
        const back = parseSchema(formatSchema(schema));
        // A blank key formats to nothing, so "parses" must also keep every row.
        expect(draftErrors(draft).size === 0).toBe(back.ok && back.schema.length === draft.length);
        if (draftErrors(draft).size === 0 && back.ok) expect(formatSchema(back.schema)).toBe(formatSchema(schema));
      })
    );
  });
});
