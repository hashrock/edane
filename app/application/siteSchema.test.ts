import { describe, it, expect } from "vitest";
import { parseSchema, formatSchema, inferSchema, shapeRecords, defaultTemplate } from "./siteSchema";
import type { SiteNode } from "./siteTemplate";

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
