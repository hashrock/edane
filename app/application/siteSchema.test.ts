import { describe, it, expect } from "vitest";
import { parseSchema, formatSchema, inferSchema, shapeRecords, defaultTemplate, migrateSiteSchema } from "./siteSchema";
import type { SiteNode } from "./siteNode";

const n = (id: string, text: string, type: SiteNode["type"] = "text", children: SiteNode[] = []): SiteNode => ({
  id, text, type, children,
});
const root = n("r", "Cafes", "text", [
  n("a", "Nico", "text", [n("a1", "Jimbocho"), n("a2", "https://x/a", "link"), n("a3", "tags", "text", [n("t1", "retro"), n("t2", "pasta")])]),
  n("b", "Roast", "text", [n("b1", "Shibuya"), n("b2", "https://x/b", "link"), n("b3", "tags", "text", [n("t3", "coffee")]), n("b4", "extra")]),
  n("c", "Yama", "text", [n("c1", "Kichijoji"), n("c2", "https://img/c.jpg", "image")]),
]);

describe("parseSchema", () => {
  it("parses keys, type annotations and list marks", () => {
    expect(parseSchema("area, url:link, tags[], image: image")).toEqual({
      ok: true,
      schema: [
        { key: "area", type: undefined, list: false },
        { key: "url", type: "link", list: false },
        { key: "tags", type: undefined, list: true },
        { key: "image", type: "image", list: false },
      ],
    });
  });
  it("accepts newlines, ignores empties, rejects reserved / duplicate / bad keys / bad types", () => {
    expect(parseSchema("a\n\nb,").ok).toBe(true);
    expect(parseSchema("title").ok).toBe(false);
    expect(parseSchema("a, a").ok).toBe(false);
    expect(parseSchema("1a").ok).toBe(false);
    expect(parseSchema("a:video").ok).toBe(false);
    expect(parseSchema("a b").ok).toBe(false);
  });
  it("round-trips through formatSchema", () => {
    const text = "area, url:link, tags[], image:image";
    const p = parseSchema(text);
    expect(p.ok && formatSchema(p.schema)).toBe(text);
  });
});

describe("inferSchema", () => {
  it("names positions by majority type and detects list columns", () => {
    expect(formatSchema(inferSchema(root))).toBe("field1, url:link, items[], field4");
  });
  it("is empty for a branch without records", () => {
    expect(inferSchema(n("r", "x"))).toEqual([]);
  });
  it("detects markdown majority", () => {
    const r = n("r", "Notes", "text", [
      n("a", "A", "text", [n("a1", "# hi", "markdown")]),
      n("b", "B", "text", [n("b1", "# yo", "markdown")]),
      n("c", "C", "text", [n("c1", "plain")]),
    ]);
    expect(formatSchema(inferSchema(r))).toBe("body:markdown");
  });
});

describe("shapeRecords", () => {
  const schema = parseSchema("area, url:link, tags[]");
  if (!schema.ok) throw new Error();
  it("builds items keyed by schema, missing fields undefined, lists from children", () => {
    const { items } = shapeRecords(root, schema.schema);
    expect(items[0]).toEqual({ id: "a", title: "Nico", area: "Jimbocho", url: "https://x/a", tags: ["retro", "pasta"] });
    expect(items[2]).toEqual({ id: "c", title: "Yama", area: "Kichijoji", url: "https://img/c.jpg" });
    expect(items[2].tags).toBeUndefined();
  });
  it("warns on type mismatch and extra children", () => {
    const { warnings } = shapeRecords(root, schema.schema);
    expect(warnings).toEqual(["Roast: スキーマより 1 個多い子があります", "Yama: url は link のはずが image"]);
  });
});

describe("defaultTemplate", () => {
  it("imports items, marks cards and renders each field by kind", () => {
    const schema = parseSchema("area, url:link, image:image, tags[]");
    if (!schema.ok) throw new Error();
    const t = defaultTemplate(schema.schema);
    expect(t).toContain("import { items, title } from './data.js'");
    expect(t).toContain("{title}");
    expect(t).toContain("data-card");
    expect(t).toContain("data-search");
    expect(t).toContain("<img src={item.image}");
    expect(t).toContain("<a href={item.url}");
    expect(t).toContain("(item.tags ?? []).map");
    expect(t).toContain("{item.area}");
  });
});

describe("parseSchema against prototype names", () => {
  // `"toString" in FIELD_TYPES` is true via Object.prototype; the type
  // annotation must be an own key (found by the preferences property test
  // hitting the same idiom).
  it("rejects an inherited property name as a type annotation", () => {
    for (const name of ["toString", "constructor", "hasOwnProperty", "valueOf"]) {
      expect(parseSchema(`a:${name}`).ok).toBe(false);
    }
  });
});

describe("shapeRecords with value types and nesting", () => {
  it("reads check as boolean, number as number and nested collections as records", () => {
    const schema = parseSchema("done:check, price:number, ch[]{page:number}");
    if (!schema.ok) throw new Error();
    const r = n("r", "Books", "text", [
      n("a", "A", "text", [
        { ...n("a0", "read"), checked: true },
        n("a1", " 12.5 "),
        n("a2", "chapters", "text", [n("s1", "Intro", "text", [n("p1", "3")]), n("s2", "Body", "text", [n("p2", "x")])]),
      ]),
    ]);
    const { items, warnings } = shapeRecords(r, schema.schema);
    expect(items[0]).toEqual({
      id: "a",
      title: "A",
      done: true,
      price: 12.5,
      ch: [
        { id: "s1", title: "Intro", page: 3 },
        { id: "s2", title: "Body", page: undefined },
      ],
    });
    expect(warnings).toEqual(['Body: page は number のはずが "x"']);
  });
});

describe("migrateSiteSchema", () => {
  const doc = { title: "", roots: [{ id: "c", text: "C", children: [] }] };
  it("moves the legacy site schema onto the published node", () => {
    expect(migrateSiteSchema(doc, "c", " a, b:image ")?.roots[0].schema).toBe("a, b:image");
  });
  it("does nothing when blank, the node is gone, or the node already has one", () => {
    expect(migrateSiteSchema(doc, "c", "  ")).toBeNull();
    expect(migrateSiteSchema(doc, "zz", "a")).toBeNull();
    expect(migrateSiteSchema({ title: "", roots: [{ id: "c", text: "", schema: "x", children: [] }] }, "c", "a")).toBeNull();
  });
});
