/**
 * `planPaste` is a pure decision function — `PasteContext` (4 booleans/string) ->
 * `PastePlan` (6-way union) — but pastePlan.test.ts only exercises it against a
 * dozen hand-picked contexts. Since the whole function is a precedence chain
 * over its four inputs, it is directly PBT-able the same way
 * editSurface.property.test.ts total-enumerates handleAuxInputKeys. This file
 * asserts the precedence rules over arbitrary contexts instead of fixed
 * examples.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { planPaste, type PasteContext } from "./pastePlan";
import { looksLikeMarkdown } from "./markdown";

const contextArb: fc.Arbitrary<PasteContext> = fc.record({
  editing: fc.boolean(),
  text: fc.string(),
  hasBranchJson: fc.boolean(),
  hasInternalClipboard: fc.boolean(),
});

describe("planPaste: precedence chain over arbitrary contexts", () => {
  it("editing always wins: native, regardless of everything else on the clipboard", () => {
    fc.assert(
      fc.property(contextArb, (ctx) => {
        fc.pre(ctx.editing);
        expect(planPaste(ctx)).toBe("native");
      })
    );
  });

  it("our branch JSON wins over Markdown text/plain and the internal clipboard, once not editing", () => {
    fc.assert(
      fc.property(contextArb, (ctx) => {
        fc.pre(!ctx.editing && ctx.hasBranchJson);
        expect(planPaste(ctx)).toBe("branch-json");
      })
    );
  });

  it("Markdown-looking text wins over the internal clipboard, once not editing and no branch JSON", () => {
    // A leading "# " makes the first line match HEADING regardless of what
    // follows, so this constructs looksLikeMarkdown(text) === true by
    // construction instead of filtering arbitrary strings down to a trickle.
    const markdownTextArb = fc.string().map((s) => `# ${s}`);
    fc.assert(
      fc.property(
        fc.record({
          editing: fc.constant(false),
          text: markdownTextArb,
          hasBranchJson: fc.constant(false),
          hasInternalClipboard: fc.boolean(),
        }),
        (ctx) => {
          expect(looksLikeMarkdown(ctx.text)).toBe(true);
          expect(planPaste(ctx)).toBe("markdown-dialog");
        }
      )
    );
  });

  it("the internal clipboard is used once branch JSON and Markdown are both ruled out", () => {
    fc.assert(
      fc.property(contextArb, (ctx) => {
        fc.pre(
          !ctx.editing &&
            !ctx.hasBranchJson &&
            !looksLikeMarkdown(ctx.text) &&
            ctx.hasInternalClipboard
        );
        expect(planPaste(ctx)).toBe("branch-clipboard");
      })
    );
  });

  it("falls through to none/text-as-nodes by text emptiness once every other source is ruled out", () => {
    fc.assert(
      fc.property(contextArb, (ctx) => {
        fc.pre(
          !ctx.editing &&
            !ctx.hasBranchJson &&
            !looksLikeMarkdown(ctx.text) &&
            !ctx.hasInternalClipboard
        );
        expect(planPaste(ctx)).toBe(ctx.text ? "text-as-nodes" : "none");
      })
    );
  });
});
