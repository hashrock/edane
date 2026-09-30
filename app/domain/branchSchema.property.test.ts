/**
 * Property-based tests for branch schemas: the text format round-trips
 * and never throws, and conformEntering only ever ADDS —
 * blank fields at the end of entering records, a type on a new blank node —
 * never touching what was already there.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  conformEntering,
  FIELD_TYPES,
  formatSchema,
  parseSchema,
  RESERVED_KEYS,
  schemaRoles,
  type BranchSchema,
} from "./branchSchema";
import { cloneWithNewIds, findNode, type MindMapDocument, type MindMapModel } from "./model";
import { allIds, expectUniqueIds, modelArb, nodeArb, pick, sequentialIds } from "./model.arb";

const keyArb = fc
  .stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,5}$/)
  .filter((k) => !(RESERVED_KEYS as readonly string[]).includes(k));

const schemaArb: fc.Arbitrary<BranchSchema> = fc.uniqueArray(
  fc.record({ key: keyArb, type: fc.constantFrom(...FIELD_TYPES) }, { requiredKeys: ["key"] }),
  { selector: (f) => f.key, maxLength: 5 }
);

/** formatSchema writes `text` as "no annotation", so that is what comes back. */
function normalize(schema: BranchSchema): BranchSchema {
  return schema.map((f) => ({ key: f.key, type: f.type === "text" ? undefined : f.type }));
}

/** Every node of `doc` as id → node, for "what happened to this node" checks. */
function index(doc: MindMapDocument): Map<string, MindMapModel> {
  const m = new Map<string, MindMapModel>();
  const walk = (n: MindMapModel) => {
    m.set(n.id, n);
    n.children.forEach(walk);
  };
  doc.roots.forEach(walk);
  return m;
}

describe("branch schema text", () => {
  it("round-trips through formatSchema", () => {
    fc.assert(
      fc.property(schemaArb, (schema) => {
        expect(parseSchema(formatSchema(schema))).toEqual({ ok: true, schema: normalize(schema) });
      })
    );
  });
  it("never throws on arbitrary text", () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom(..."ab:{}, \n\timage"), maxLength: 30 }), (text) => {
        parseSchema(text);
      })
    );
  });
});

describe("conformEntering", () => {
  // `prev` = a document, `next` = the same document with a pasted branch
  // appended under a random node — every node in the branch is new.
  const pastedArb = fc.tuple(modelArb, nodeArb, fc.nat()).map(([prev, branch, n]) => {
    const next: MindMapDocument = structuredClone(prev);
    const target = findNode(next, pick(allIds(next), n))!;
    target.children.push(cloneWithNewIds(branch, sequentialIds("p")));
    return { prev, next };
  });

  it("keeps ids unique and leaves the document alone when nothing moved", () => {
    fc.assert(
      fc.property(modelArb, (doc) => {
        expect(conformEntering(doc, doc)).toBe(doc);
      })
    );
  });

  it("only appends fields and types new blank nodes; entering records reach their schema width", () => {
    fc.assert(
      fc.property(pastedArb, ({ prev, next }) => {
        const out = conformEntering(prev, next, sequentialIds("f"));
        expectUniqueIds(out);
        const before = index(next);
        const after = index(out);
        for (const [id, node] of before) {
          const got = after.get(id)!;
          // Existing children stay, in order, as a prefix.
          expect(got.children.slice(0, node.children.length).map((c) => c.id)).toEqual(node.children.map((c) => c.id));
          const { type: _t, checked: _c, children: _k, ...rest } = got;
          const { type: _t2, checked: _c2, children: _k2, ...restBefore } = node;
          expect(rest).toEqual(restBefore);
          // type / checked change only on a blank new node that had neither.
          if (got.type !== node.type || got.checked !== node.checked) {
            expect(prev.roots.some((r) => findNode({ ...prev, roots: [r] }, id))).toBe(false);
            expect(node.text).toBe("");
            expect(node.type).toBeUndefined();
            expect(node.checked).toBeUndefined();
          }
        }
        const roles = schemaRoles(out);
        const prevIds = new Set(allIds(prev));
        for (const [id, role] of roles) {
          if (role.kind === "record" && !prevIds.has(id) && before.has(id)) {
            expect(after.get(id)!.children.length).toBeGreaterThanOrEqual(role.fields.length);
          }
        }
      })
    );
  });
});
