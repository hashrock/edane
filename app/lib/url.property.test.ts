/**
 * Property-based tests for absoluteUrl: the one rule shared by every module
 * that builds an absolute URL from an origin and a path (public note links,
 * node publication URLs, site URLs, scenario fixtures).
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { absoluteUrl } from "./url";

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
