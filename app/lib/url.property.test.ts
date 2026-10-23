/**
 * Property-based tests for absoluteUrl: the one rule shared by every module
 * that builds an absolute URL from an origin and a path (public note links,
 * node publication URLs, web page URLs, scenario fixtures).
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { absoluteUrl, safeExternalUrl } from "./url";

// A clean origin (no trailing slash) plus a slash count to append: the
// property below is that the count never changes the result. absoluteUrl
// does no path parsing, so any string is a valid path.
const cleanOriginArb = fc.constantFrom(
  "https://edane.app",
  "http://localhost:5173",
  "https://example.com:8443"
);
const slashesArb = fc.integer({ min: 0, max: 5 }).map((n) => "/".repeat(n));
const pathArb = fc.string();

describe("absoluteUrl", () => {
  it("doesn't matter how many trailing slashes the origin already has", () => {
    fc.assert(
      fc.property(cleanOriginArb, slashesArb, pathArb, (origin, slashes, path) => {
        expect(absoluteUrl(origin + slashes, path)).toBe(`${origin}${path}`);
      })
    );
  });
});

describe("safeExternalUrl", () => {
  it.each(["https://example.com/a?b#c", "http://localhost:3000/"])("keeps %s", (u) => {
    expect(safeExternalUrl(u)).toBe(new URL(u).toString());
  });
  it.each(["javascript:alert(1)", " JavaScript:alert(1)", "data:text/html,x", "vbscript:x", "file:///etc/passwd", "not a url", "", null, undefined])(
    "refuses %s",
    (u) => expect(safeExternalUrl(u)).toBeNull()
  );
  it("only ever returns http(s)", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const out = safeExternalUrl(s);
        expect(out === null || /^https?:\/\//.test(out)).toBe(true);
      })
    );
  });
});
