import { describe, it, expect } from "vitest";
import {
  conformEntering,
  fieldIssue,
  formatSchema,
  isDateText,
  parseSchema,
  schemaRoles,
} from "./branchSchema";
import type { MindMapDocument, MindMapModel } from "./model";
import { sequentialIds } from "./model.arb";

const n = (id: string, text: string, children: MindMapModel[] = [], extra: Partial<MindMapModel> = {}): MindMapModel => ({
  id,
  text,
  children,
  ...extra,
});
const doc = (...roots: MindMapModel[]): MindMapDocument => ({ title: "", roots });

describe("parseSchema", () => {
  it("parses keys and value types", () => {
    expect(parseSchema("author, done:check, price:number, on: date")).toEqual({
      ok: true,
      schema: [
        { key: "author", type: undefined },
        { key: "done", type: "check" },
        { key: "price", type: "number" },
        { key: "on", type: "date" },
      ],
    });
  });
  it("rejects bad keys and unknown types", () => {
    expect(parseSchema("a[]").ok).toBe(false);
    expect(parseSchema("a{b}").ok).toBe(false);
    expect(parseSchema("title").ok).toBe(false);
    expect(parseSchema("a:bool").ok).toBe(false);
  });
});

describe("isDateText", () => {
  it("accepts real calendar dates only", () => {
    expect(isDateText("2026-09-30")).toBe(true);
    expect(isDateText("2026-02-30")).toBe(false);
    expect(isDateText("2026/09/30")).toBe(false);
  });
});

describe("schemaRoles", () => {
  const tree = n("c", "Books", [
    n("r1", "Book A", [
      n("f0", "Alice"),
      n("f1", "https://x/c.png", [], { type: "image" }),
      n("f2", "chapters", [n("s1", "Intro", [n("p1", "3")])], { schema: "page:number" }),
      n("extra", "?"),
    ]),
  ], { schema: "author, cover:image, chapters" });
  const roles = schemaRoles(doc(tree));

  it("marks records, fields by index, and nests under a field node that has its own schema", () => {
    expect(roles.get("c")).toBeUndefined();
    expect(roles.get("r1")).toMatchObject({ kind: "record", collectionId: "c" });
    expect(roles.get("f0")).toMatchObject({ kind: "field", index: 0, field: { key: "author" } });
    expect(roles.get("f1")).toMatchObject({ kind: "field", index: 1, field: { key: "cover" } });
    expect(roles.get("f2")).toMatchObject({ kind: "field", index: 2, field: { key: "chapters" } });
    expect(roles.get("s1")).toMatchObject({ kind: "record", collectionId: "f2" });
    expect(roles.get("p1")).toMatchObject({ kind: "field", index: 0, field: { key: "page" } });
  });
  it("leaves children beyond the schema without a role", () => {
    expect(roles.get("extra")).toBeUndefined();
  });
  it("ignores an unparsable schema", () => {
    expect(schemaRoles(doc(n("c", "x", [n("r", "y")], { schema: "a{" }))).size).toBe(0);
  });
});

describe("fieldIssue", () => {
  it("flags kind / value mismatches but not blank text", () => {
    expect(fieldIssue(n("a", "hi"), "image")).toBe("image");
    expect(fieldIssue(n("a", ""), "image")).toBeNull();
    expect(fieldIssue(n("a", "x", [], { type: "image" }), "image")).toBeNull();
    expect(fieldIssue(n("a", "12.5"), "number")).toBeNull();
    expect(fieldIssue(n("a", "twelve"), "number")).toBe("number");
    expect(fieldIssue(n("a", "2026-01-01"), "date")).toBeNull();
    expect(fieldIssue(n("a", "anything"), "check")).toBe("check");
    expect(fieldIssue(n("a", "anything", [], { checked: true }), "check")).toBeNull();
    expect(fieldIssue(n("a", "anything"), undefined)).toBeNull();
  });
});

describe("conformEntering", () => {
  const schema = "author, cover:image, done:check, tags";
  const base = doc(n("c", "Books", [n("r1", "A", [n("a1", "Alice")])], { schema }));

  it("pads a new record with typed blank fields", () => {
    const next = doc(n("c", "Books", [n("r1", "A", [n("a1", "Alice")]), n("r2", "B")], { schema }));
    const out = conformEntering(base, next, sequentialIds("f"));
    expect(out.roots[0].children[1].children).toEqual([
      { id: "f0", text: "", children: [] },
      { id: "f1", text: "", children: [], type: "image" },
      { id: "f2", text: "", children: [], checked: false },
      { id: "f3", text: "", children: [] },
    ]);
    // The record that was already there is left alone.
    expect(out.roots[0].children[0].children).toHaveLength(1);
  });

  it("types a new blank node created in a field position", () => {
    const next = doc(n("c", "Books", [n("r1", "A", [n("a1", "Alice"), n("x", "")])], { schema }));
    const out = conformEntering(base, next, sequentialIds("f"));
    expect(out.roots[0].children[0].children[1]).toEqual({ id: "x", text: "", children: [], type: "image" });
  });

  it("returns the same document when nothing entered a schema position", () => {
    const next = doc(n("c", "Books!", [n("r1", "A", [n("a1", "Alice")])], { schema }));
    expect(conformEntering(base, next)).toBe(next);
  });

});
