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
    const text = "author, cover:image, tags[]:link, ch[]{name, page:number}";
    expect(formatSchema(fromDraft(toDraft(parsed(text), ridSource())))).toBe(text);
  });

  it("edits rows at any depth", () => {
    const rid = ridSource();
    let d = toDraft(parsed("a, ch[]{x, y}"), rid); // f0=a f1=ch f2=x f3=y
    d = moveField(d, "f3", -1);
    d = updateField(d, "f0", { kind: "image" });
    d = addField(d, "f1", blankField(rid));
    d = updateField(d, "f4", { key: "z", kind: "date" });
    d = removeField(d, "f2");
    expect(formatSchema(fromDraft(d))).toBe("a:image, ch[]{y, z:date}");
  });

  it("forces records to be a list and drops children when it stops being records", () => {
    let d = toDraft(parsed("a"), ridSource());
    d = updateField(d, "f0", { kind: "records" });
    expect(d[0].list).toBe(true);
    d = addField(d, "f0", { ...blankField(() => "n"), key: "x" });
    d = updateField(d, "f0", { kind: "text" });
    expect(d[0].fields).toEqual([]);
  });

  it("reports empty, invalid, reserved and duplicate keys per level", () => {
    const d = toDraft(parsed("a, ch[]{a, b}"), ridSource());
    const withBad: DraftField[] = [
      ...d,
      { ...blankField(() => "e1") },
      { ...blankField(() => "e2"), key: "a" },
      { ...blankField(() => "e3"), key: "title" },
      { ...blankField(() => "e4"), key: "1x" },
    ];
    expect([...draftErrors(withBad).keys()]).toEqual(["e1", "e2", "e3", "e4"]);
  });

  it("a draft has no errors exactly when its text form parses back to the same schema", () => {
    const keyArb = fc.constantFrom("", "a", "b", "title", "1x", "ok_1");
    const rowArb: fc.Arbitrary<DraftField> = fc.letrec<{ row: DraftField }>((tie) => ({
      row: fc
        .record({
          key: keyArb,
          kind: fc.constantFrom(...DRAFT_KINDS),
          list: fc.boolean(),
          fields: fc.array(tie("row"), { maxLength: 2 }),
        })
        .map((r) => ({
          rid: "",
          ...r,
          list: r.kind === "records" ? true : r.list,
          fields: r.kind === "records" ? r.fields : [],
        })),
    })).row;
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 4 }), (rows) => {
        let i = 0;
        const number = (rs: DraftField[]): DraftField[] =>
          rs.map((r) => ({ ...r, rid: `r${i++}`, fields: number(r.fields) }));
        const draft = number(rows);
        const schema = fromDraft(draft);
        const back = parseSchema(formatSchema(schema));
        expect(draftErrors(draft).size === 0).toBe(back.ok);
        if (back.ok) expect(formatSchema(back.schema)).toBe(formatSchema(schema));
      })
    );
  });
});
