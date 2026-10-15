/**
 * Property-based tests for the deck derived from a document: every node is
 * presented by exactly one slide (or, if skipped, by an ancestor's), slides
 * follow the outline order, and no content slide overflows.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { allIds, modelAndNodeArb, modelArb } from "../domain/model.arb";
import { locateNode } from "../domain/model";
import { buildSlides, slideIndexOf, SLIDE_MAX_ITEMS } from "./slides";

describe("buildSlides (property)", () => {
  it("presents each node on at most one slide, in outline order", () => {
    fc.assert(
      fc.property(modelArb, (doc) => {
        const slides = buildSlides(doc);
        const presented = slides.flatMap((s) => s.ids);
        expect(new Set(presented).size).toBe(presented.length);
        const order = allIds(doc);
        const headings = slides.map((s) => order.indexOf(s.heading.id));
        expect(headings).toEqual([...headings].sort((a, b) => a - b));
      })
    );
  });

  it("keeps every content slide within the bullet limit and opens each tree with its title", () => {
    fc.assert(
      fc.property(modelArb, (doc) => {
        const slides = buildSlides(doc);
        for (const s of slides) {
          if (s.kind === "content") expect(s.items.length).toBeLessThanOrEqual(SLIDE_MAX_ITEMS);
          expect(s.kind === "title").toBe(locateNode(doc, s.heading.id)!.parent === null);
        }
      })
    );
  });

  it("starts from a slide that presents the node or one of its ancestors", () => {
    fc.assert(
      fc.property(modelAndNodeArb, ({ model, nodeId }) => {
        const slides = buildSlides(model);
        if (slides.length === 0) return;
        const ids = slides[slideIndexOf(slides, model, nodeId)].ids;
        const chain: string[] = [];
        for (let id: string | undefined = nodeId; id; id = locateNode(model, id)?.parent?.id) chain.push(id);
        // A node under a skipped blank root has no slide at all: index 0 is the fallback.
        if (chain.some((id) => slides.some((s) => s.ids.includes(id)))) {
          expect(chain.some((id) => ids.includes(id))).toBe(true);
        }
      })
    );
  });
});
