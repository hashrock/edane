/**
 * Property-based tests for the MindMapModel -> SiteNode projection: the public
 * site must see exactly the branch's shape, order and content, and none of the
 * editor's view state.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { MindMapModel } from "../domain/model";
import { nodeArb } from "../domain/model.arb";
import { toSiteNode, type SiteNode } from "./siteNode";

function walkPair(model: MindMapModel, site: SiteNode, visit: (m: MindMapModel, s: SiteNode) => void) {
  visit(model, site);
  expect(site.children).toHaveLength(model.children.length);
  model.children.forEach((c, i) => walkPair(c, site.children[i], visit));
}

describe("toSiteNode (property)", () => {
  it("mirrors the tree: same shape and order, ids and text copied, type defaulted to text", () => {
    fc.assert(
      fc.property(nodeArb, (node) => {
        walkPair(node, toSiteNode(node), (m, s) => {
          expect(s.id).toBe(m.id);
          expect(s.text).toBe(m.text);
          expect(s.type).toBe(m.type ?? "text");
        });
      })
    );
  });

  it("carries only the site-facing keys (no collapsed/bold/position/... view state)", () => {
    const allowed = new Set(["id", "type", "text", "checked", "schema", "children"]);
    fc.assert(
      fc.property(nodeArb, (node) => {
        walkPair(node, toSiteNode(node), (_m, s) => {
          for (const key of Object.keys(s)) expect(allowed.has(key)).toBe(true);
        });
      })
    );
  });

  it("keeps `checked` when set and omits an empty schema", () => {
    fc.assert(
      fc.property(nodeArb, (node) => {
        walkPair(node, toSiteNode(node), (m, s) => {
          expect(s.checked).toBe(m.checked);
          expect("checked" in s).toBe(m.checked !== undefined);
          expect(s.schema).toBe(m.schema ? m.schema : undefined);
        });
      })
    );
  });

  it("does not mutate its input", () => {
    fc.assert(
      fc.property(nodeArb, (node) => {
        const before = structuredClone(node);
        toSiteNode(node);
        expect(node).toEqual(before);
      })
    );
  });
});
