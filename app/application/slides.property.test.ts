/**
 * Property-based tests for the deck derived from a document: every node is
 * presented by exactly one slide (or, if skipped, by an ancestor's), slides
 * follow the outline order, no content slide overflows unless it holds a
 * single indivisible item, and no leaf gets a heading-only slide unasked.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { allIds, modelAndNodeArb, modelArb } from "../domain/model.arb";
import { findNode, locateNode } from "../domain/model";
import { ancestry, buildSlides, isBlankLeaf, slideFits, slideIndexOf } from "./slides";

describe("buildSlides (property)", () => {
  it("presents each node with content on exactly one slide, in outline order", () => {
    fc.assert(
      fc.property(modelArb, (doc) => {
        const slides = buildSlides(doc);
        const presented = slides.flatMap((s) => s.ids);
        expect(new Set(presented).size).toBe(presented.length);
        for (const id of allIds(doc)) {
          if (!isBlankLeaf(findNode(doc, id)!)) expect(presented).toContain(id);
        }
        // Headings first appear in outline order (a heading may come back:
        // a list continued after a child's slides).
        const order = allIds(doc);
        const firsts = [...new Set(slides.map((s) => s.heading.id))].map((id) => order.indexOf(id));
        expect(firsts).toEqual([...firsts].sort((a, b) => a - b));
      })
    );
  });

  it("keeps content slides on the page, opens each tree with its title, and makes no heading-only slide for a leaf unasked", () => {
    fc.assert(
      fc.property(modelArb, (doc) => {
        const slides = buildSlides(doc);
        for (const s of slides) {
          const parent = locateNode(doc, s.heading.id)!.parent;
          expect(s.kind === "title").toBe(parent === null);
          if (s.kind !== "content") continue;
          const units = s.items.filter((i) => i.depth === 0).length;
          expect(units <= 1 || slideFits(s.heading, s.items)).toBe(true);
          if (s.items.length === 0 && s.heading.children.length === 0) {
            expect(parent!.slideSplit === true || locateNode(doc, parent!.id)!.parent === null).toBe(true);
          }
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
        const chain = ancestry(model, nodeId);
        // A node under a skipped blank root has no slide at all: index 0 is the fallback.
        if (chain.some((id) => slides.some((s) => s.ids.includes(id)))) {
          expect(chain.some((id) => ids.includes(id))).toBe(true);
        }
      })
    );
  });
});
