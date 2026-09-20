/**
 * The compact markdown card's title and badge. `markdownTitle` picks the first
 * meaningful line, strips list/heading/quote markers and inline decoration and
 * clips at `maxLen` (plus one ellipsis character); it is never empty and never
 * spans lines. `markdownLineCount` counts non-blank lines, so it is additive
 * over concatenation and bounded by the line count.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { markdownLineCount, markdownTitle, MD_TITLE_MAX } from "./markdownCard";

const lineArb = fc.oneof(
  fc.string({ maxLength: 60 }),
  fc.tuple(fc.constantFrom("# ", "## ", "- ", "* ", "1. ", "> ", "**", "`"), fc.string({ maxLength: 50 })).map(([m, s]) => m + s)
).map((s) => s.replace(/\n/g, " "));
const srcArb = fc.array(lineArb, { maxLength: 6 }).map((ls) => ls.join("\n"));

describe("markdownTitle", () => {
  it("is non-empty, single-line, at most maxLen + 1 chars (one layer of markers stripped)", () => {
    fc.assert(
      fc.property(srcArb, fc.integer({ min: 1, max: 60 }), (src, maxLen) => {
        const title = markdownTitle(src, maxLen);
        expect(title).not.toBe("");
        expect(title).not.toContain("\n");
        expect(title.length).toBeLessThanOrEqual(maxLen + 1);
        if (title.length === maxLen + 1) expect(title.endsWith("…")).toBe(true);
        expect(markdownTitle(src)).toBe(markdownTitle(src, MD_TITLE_MAX));
      })
    );
  });

  it("comes from the first line that has text once markers are stripped, untouched by whatever follows", () => {
    fc.assert(
      fc.property(srcArb, srcArb, (a, b) => {
        // Prepending lines that are blank after stripping doesn't change the title.
        const blanks = "\n   \n# \n**\n";
        expect(markdownTitle(blanks + a)).toBe(markdownTitle(a));
        // Once `a` has a title of its own, appending `b` can't change it.
        if (markdownLineCount(a.replace(/[#*_`>\-+\d.)]/g, "")) > 0) {
          expect(markdownTitle(a + "\n" + b)).toBe(markdownTitle(a));
        }
      })
    );
  });
});

describe("markdownLineCount", () => {
  it("counts non-blank lines: additive over concatenation, bounded by the line count, zero for blank input", () => {
    fc.assert(
      fc.property(srcArb, srcArb, (a, b) => {
        expect(markdownLineCount(a + "\n" + b)).toBe(markdownLineCount(a) + markdownLineCount(b));
        expect(markdownLineCount(a)).toBeLessThanOrEqual(a.split("\n").length);
        expect(markdownLineCount(a)).toBe(a.split("\n").filter((l) => l.trim() !== "").length);
      })
    );
  });
  it("is zero for whitespace-only input", () => {
    fc.assert(fc.property(fc.stringMatching(/^[ \t\n]*$/), (s) => {
        expect(markdownLineCount(s)).toBe(0);
      }));
  });
});
