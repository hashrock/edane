/**
 * Property-based test for measureModelNode's width cap.
 *
 * `measureModelNode` is documented as THE single source of truth for node
 * sizing, and every kind is supposed to stay inside NODE_MAX_CONTENT_WIDTH —
 * the canvas layout and the drag-drop hit test both build on that holding
 * unconditionally. `nodeUtils.test.ts` pins it with one hand-picked LONG
 * string per kind; this sweeps the field space instead (kind, checkbox,
 * favicon, font size, bold, arbitrary text) so a new combination can't slip
 * a box past the cap unnoticed.
 *
 * node has no Canvas 2D, so text measurement runs the character-count
 * estimate (see lib/measureText.ts) — the cap still applies, it's just not
 * pixel-perfect.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { STORED_NODE_TYPES, type MindMapModel } from "../domain/model";
import { measureModelNode } from "./nodeUtils";
import { NODE_MAX_CONTENT_WIDTH } from "../lib/measureText";

/**
 * Long enough to force wrapping/clipping for every kind (LONG in
 * nodeUtils.test.ts is 600 "x"s). Trailing whitespace on a hard line is
 * stripped: a wrapped line's trailing space is deliberately kept and counted
 * in its width (so the caret has somewhere to sit — see wrapOneLine's
 * trimLineEnd), which can push a box a hair past the cap. That's an accepted,
 * separately-documented exception (see measureText.property.test.ts's own
 * "wraps only within the cap" test), not the invariant this test is after.
 */
const longTextArb = fc
  .oneof(
    fc.string({ minLength: 200, maxLength: 800 }),
    fc
      .array(fc.constantFrom("supercalifragilistic", "日本語のテキスト", "a", " ", "\n"), {
        minLength: 20,
        maxLength: 60,
      })
      .map((ws) => ws.join(" "))
  )
  .map((text) =>
    text
      .split("\n")
      .map((line) => line.replace(/\s+$/, ""))
      .join("\n")
  );

const fieldsArb = fc.record(
  {
    text: longTextArb,
    type: fc.constantFrom(...STORED_NODE_TYPES),
    checked: fc.option(fc.boolean(), { nil: undefined }),
    favicon: fc.option(fc.constant("https://e/f.ico"), { nil: undefined }),
    fontSize: fc.option(fc.integer({ min: 8, max: 64 }), { nil: undefined }),
    bold: fc.option(fc.boolean(), { nil: undefined }),
  },
  { requiredKeys: ["text"] }
);

function model(fields: Partial<MindMapModel>): MindMapModel {
  return { id: "n", text: "", children: [], ...fields };
}

describe("measureModelNode width cap (property)", () => {
  it("keeps every kind/checkbox/favicon/font-size/bold combination inside the cap", () => {
    fc.assert(
      fc.property(fieldsArb, (fields) => {
        expect(measureModelNode(model(fields)).width).toBeLessThanOrEqual(
          NODE_MAX_CONTENT_WIDTH
        );
      }),
      { numRuns: 500 }
    );
  });

  it("caps the live edit buffer too, whatever the node's own (stored) kind and text", () => {
    fc.assert(
      fc.property(fieldsArb, longTextArb, (fields, editingText) => {
        expect(
          measureModelNode(model(fields), editingText).width
        ).toBeLessThanOrEqual(NODE_MAX_CONTENT_WIDTH);
      }),
      { numRuns: 500 }
    );
  });
});
