/**
 * `escapeHtml` is a security boundary (used to build the 404 page and the
 * server-rendered Markdown), so its contract is checked against arbitrary
 * strings rather than a handful of hand-picked examples.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { escapeHtml, jsonForScript } from "./escapeHtml";

/** Inverse of escapeHtml: `&amp;` must be undone last, or a literal "&lt;" in
 *  the input (itself escaped to "&amp;lt;") would be mistaken for a `<` that
 *  survived escaping. */
function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

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

describe("jsonForScript", () => {
  it("round-trips through JSON.parse and never contains `<`", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        const out = jsonForScript(v);
        expect(out).not.toContain("<");
        expect(JSON.parse(out)).toEqual(JSON.parse(JSON.stringify(v)));
      })
    );
  });
  it("neutralizes script-ending and comment-opening sequences", () => {
    const out = jsonForScript({ t: "</script><!--<script>\u2028" });
    expect(out).not.toMatch(/<\/script|<!--|\u2028/);
  });
});
