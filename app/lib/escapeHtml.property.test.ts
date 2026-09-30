/**
 * `escapeHtml` is a security boundary (used to build the 404 page and the
 * public site's `<title>`), so its contract is checked against arbitrary
 * strings rather than a handful of hand-picked examples.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { escapeHtml } from "./escapeHtml";
import { unescapeHtml } from "./escapeHtml.testHelpers";

describe("escapeHtml", () => {
  it("round-trips through unescapeHtml for any string", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(unescapeHtml(escapeHtml(s))).toBe(s);
      })
    );
  });

  it("never leaves a raw &, <, > or \" in the output", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const escaped = escapeHtml(s);
        // Every "&" that appears must open one of the four known entities.
        const bareAmpersand = escaped.match(/&(?!amp;|lt;|gt;|quot;)/);
        expect(bareAmpersand).toBeNull();
        expect(escaped).not.toMatch(/[<>"]/);
      })
    );
  });
});
