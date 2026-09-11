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
 * Field generation (type/checked/favicon/fontSize/bold) is drawn from the
 * shared `nodeArb` in domain/model.arb — not re-declared here — so this stays
 * in sync with what a stored node can actually look like (e.g. `bold` is
 * absent-or-`true`, never a literal `false`; see that file's comment).
 *
 * node has no Canvas 2D, so text measurement runs the character-count
 * estimate (see lib/measureText.ts) — the cap still applies, it's just not
 * pixel-perfect.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { MindMapModel } from "../domain/model";
import { nodeArb } from "../domain/model.arb";
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

/** A generated node with its text replaced by something long enough to stress wrapping. */
const longNodeArb: fc.Arbitrary<MindMapModel> = fc
  .tuple(nodeArb, longTextArb)
  .map(([n, text]) => ({ ...n, text }));

describe("measureModelNode width cap (property)", () => {
  it("keeps every kind/checkbox/favicon/font-size/bold combination inside the cap", () => {
    fc.assert(
      fc.property(longNodeArb, (m) => {
        expect(measureModelNode(m).width).toBeLessThanOrEqual(NODE_MAX_CONTENT_WIDTH);
      }),
      { numRuns: 300 }
    );
  });

  it("caps the live edit buffer too, whatever the node's own (stored) kind and text", () => {
    // The node's own `text` is irrelevant here (measureModelNode ignores it
    // once `editingText` is given), so this draws a plain node and varies
    // only the edit buffer — no need to pay for a second long-text draw.
    fc.assert(
      fc.property(nodeArb, longTextArb, (m, editingText) => {
        expect(measureModelNode(m, editingText).width).toBeLessThanOrEqual(
          NODE_MAX_CONTENT_WIDTH
        );
      }),
      { numRuns: 300 }
    );
  });
});
