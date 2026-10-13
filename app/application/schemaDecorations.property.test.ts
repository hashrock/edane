/**
 * Property-based tests for schemaDecorations: the derived marks must agree
 * with the domain's roles/schemas for any document, so the canvas and the
 * outline (which share this derivation) can't draw a node as something the
 * model doesn't consider it to be.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { allIds, modelArb } from "../domain/model.arb";
import { ownSchema, schemaRoles } from "../domain/branchSchema";
import { findNode, type MindMapDocument, type MindMapModel } from "../domain/model";
import { schemaDecorations } from "./schemaDecorations";

/** Give some nodes a schema so roles actually occur (modelArb rarely does). */
function withSchemas(doc: MindMapDocument, pickSchema: (i: number) => string | undefined): MindMapDocument {
  let i = 0;
  const walk = (n: MindMapModel): MindMapModel => {
    const schema = pickSchema(i++);
    const { schema: _generated, ...rest } = n;
    return { ...rest, ...(schema ? { schema } : {}), children: n.children.map(walk) };
  };
  return { ...doc, roots: doc.roots.map(walk) };
}

const SCHEMAS = ["a, b:number, c:check", "x:image, y", "d:date", "q"] as const;

const docArb = fc
  .tuple(modelArb, fc.array(fc.option(fc.constantFrom(...SCHEMAS), { nil: undefined }), { maxLength: 40 }))
  .map(([doc, picks]) => withSchemas(doc, (i) => picks[i % Math.max(picks.length, 1)]));

describe("schemaDecorations (property)", () => {
  it("decorates only existing nodes and never stores an empty decoration", () => {
    fc.assert(
      fc.property(docArb, (doc) => {
        const ids = new Set(allIds(doc));
        for (const [id, deco] of schemaDecorations(doc)) {
          expect(ids.has(id)).toBe(true);
          expect(deco.label !== undefined || deco.issue !== undefined || deco.collection === true).toBe(true);
        }
      }),
    );
  });

  it("label iff the node is a field, collection iff it holds a schema, issue only on labelled nodes", () => {
    fc.assert(
      fc.property(docArb, (doc) => {
        const decos = schemaDecorations(doc);
        const roles = schemaRoles(doc);
        for (const id of allIds(doc)) {
          const node = findNode(doc, id)!;
          const role = roles.get(id);
          const deco = decos.get(id);
          expect(deco?.label).toBe(role?.kind === "field" ? role.field.key : undefined);
          expect(deco?.collection === true).toBe(ownSchema(node) !== null);
          if (deco?.issue) expect(deco.label).toBeDefined();
        }
      }),
    );
  });

  it("a document without any schema has no decorations", () => {
    fc.assert(
      fc.property(modelArb, (doc) => {
        expect(schemaDecorations(withSchemas(doc, () => undefined)).size).toBe(0);
      }),
    );
  });
});
