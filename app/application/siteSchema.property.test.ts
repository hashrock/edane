/**
 * Property-based tests for the public-site data pipeline: MindMapModel →
 * SiteNode → (schema) → records → data module. The schema text format must
 * round-trip, parsing must never throw on arbitrary text, an inferred schema
 * must read every record of the very tree it was inferred from, and the
 * generated `data.js` must evaluate to exactly the records it was built from.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { NODE_TYPES, type MindMapModel } from "../domain/model";
import { modelArb } from "../domain/model.arb";
import { toSiteNode, type SiteNode } from "./siteNode";
import {
  formatSchema,
  inferSchema,
  parseSchema,
  RESERVED_KEYS,
  shapeRecords,
  type SiteSchema,
} from "./siteSchema";
import { siteDataModule } from "./siteTemplate";

const KEY_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const fieldArb = fc.record(
  {
    key: fc
      .stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,6}$/)
      .filter((k) => !(RESERVED_KEYS as readonly string[]).includes(k)),
    type: fc.constantFrom(...NODE_TYPES),
    list: fc.boolean(),
  },
  { requiredKeys: ["key", "list"] }
);
const schemaArb: fc.Arbitrary<SiteSchema> = fc.uniqueArray(fieldArb, {
  selector: (f) => f.key,
  maxLength: 6,
});

/** formatSchema writes `text` as "no annotation", so that is what comes back. */
const normalize = (s: SiteSchema): SiteSchema =>
  s.map(({ key, type, list }) => ({ key, type: type === "text" ? undefined : type, list }));

function expectWellFormedSchema(schema: SiteSchema) {
  const keys = schema.map((f) => f.key);
  expect(new Set(keys).size).toBe(keys.length);
  for (const f of schema) {
    expect(KEY_RE.test(f.key)).toBe(true);
    expect((RESERVED_KEYS as readonly string[]).includes(f.key)).toBe(false);
    if (f.type !== undefined) expect(NODE_TYPES).toContain(f.type);
  }
}

describe("schema text", () => {
  it("parseSchema(formatSchema(s)) round-trips (text annotation is implicit)", () => {
    fc.assert(
      fc.property(schemaArb, (schema) => {
        const back = parseSchema(formatSchema(schema));
        expect(back.ok).toBe(true);
        if (back.ok) expect(back.schema).toEqual(normalize(schema));
      })
    );
  });

  it("parseSchema never throws on arbitrary text and only accepts well-formed schemas", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 60 }), (text) => {
        const r = parseSchema(text);
        if (r.ok) expectWellFormedSchema(r.schema);
        else expect(r.error).not.toBe("");
      })
    );
  });
});

describe("toSiteNode", () => {
  it("keeps id / text / order, defaults type to text and exposes nothing else", () => {
    fc.assert(
      fc.property(modelArb, (model) => {
        const expected = (n: MindMapModel): SiteNode => ({
          id: n.id,
          type: n.type ?? "text",
          text: n.text,
          children: n.children.map(expected),
        });
        expect(toSiteNode(model)).toEqual(expected(model));
      })
    );
  });
});

describe("inferSchema / shapeRecords", () => {
  it("an inferred schema is well-formed, as wide as the widest record, and reads every record without size warnings", () => {
    fc.assert(
      fc.property(modelArb, (model) => {
        const root = toSiteNode(model);
        const schema = inferSchema(root);
        expectWellFormedSchema(schema);
        expect(schema.length).toBe(Math.max(0, ...root.children.map((r) => r.children.length)));

        const { items, warnings } = shapeRecords(root, schema);
        expect(items.length).toBe(root.children.length);
        for (const w of warnings) expect(w).not.toMatch(/多い子/);
        root.children.forEach((rec, i) => {
          const item = items[i];
          expect(item.id).toBe(rec.id);
          expect(item.title).toBe(rec.text);
          const allowed = new Set(["id", "title", ...schema.map((f) => f.key)]);
          for (const k of Object.keys(item)) expect(allowed.has(k)).toBe(true);
          schema.forEach((f, j) => {
            const node = rec.children[j];
            expect(item[f.key]).toEqual(
              node === undefined ? undefined : f.list ? node.children.map((c) => c.text) : node.text
            );
          });
        });
      })
    );
  });

  it("an untyped schema at least as wide as every record produces no warnings", () => {
    fc.assert(
      fc.property(modelArb, fc.nat({ max: 3 }), (model, extra) => {
        const root = toSiteNode(model);
        const width = Math.max(0, ...root.children.map((r) => r.children.length)) + extra;
        const schema: SiteSchema = Array.from({ length: width }, (_, i) => ({ key: `f${i}`, list: i % 2 === 0 }));
        expect(shapeRecords(root, schema).warnings).toEqual([]);
      })
    );
  });

  it("a typed schema warns exactly for the fields whose node kind differs", () => {
    fc.assert(
      fc.property(modelArb, schemaArb, (model, schema) => {
        const root = toSiteNode(model);
        const { warnings } = shapeRecords(root, schema);
        let expectedTypeWarnings = 0;
        for (const rec of root.children) {
          schema.forEach((f, i) => {
            const node = rec.children[i];
            if (node && f.type && node.type !== f.type) expectedTypeWarnings++;
          });
        }
        expect(warnings.filter((w) => /のはずが/.test(w)).length).toBe(expectedTypeWarnings);
      })
    );
  });
});

describe("siteDataModule", () => {
  it("evaluates to the records shapeRecords produced, with no raw '<' left in the source", () => {
    fc.assert(
      fc.property(modelArb, schemaArb, (model, schema) => {
        const root = toSiteNode(model);
        const src = siteDataModule(root, schema);
        expect(src).not.toContain("<");
        // The module is ESM; evaluate it as a script by turning exports into a
        // returned object.
        const body = src.replace(/^export const /gm, "const ") + "\nreturn { data, title, items, schema };";
        const evaluated = new Function(body)() as {
          data: SiteNode;
          title: string;
          items: unknown;
          schema: unknown;
        };
        expect(evaluated.data).toEqual(root);
        expect(evaluated.title).toBe(root.text);
        expect(evaluated.items).toEqual(JSON.parse(JSON.stringify(shapeRecords(root, schema).items)));
        expect(evaluated.schema).toEqual(JSON.parse(JSON.stringify(schema)));
      })
    );
  });
});
