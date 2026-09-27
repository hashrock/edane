/**
 * Property-based tests for absoluteUrl: the one rule shared by every module
 * that builds an absolute URL from an origin and a path (public note links,
 * node publication URLs, site URLs, scenario fixtures).
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { absoluteUrl } from "./url";

const originArb = fc
  .webUrl({ withFragments: false, withQueryParameters: false })
  .map((u) => new URL(u).origin);
const trailingSlashesArb = fc.integer({ min: 0, max: 5 }).map((n) => "/".repeat(n));
const pathArb = fc
  .array(fc.string({ minLength: 1, maxLength: 8 }).filter((s) => !s.includes("/")), {
    minLength: 0,
    maxLength: 4,
  })
  .map((segments) => "/" + segments.join("/"));

describe("absoluteUrl", () => {
  it("never doubles the slash between origin and path, however many the origin already has", () => {
    fc.assert(
      fc.property(originArb, trailingSlashesArb, pathArb, (origin, slashes, path) => {
        const result = absoluteUrl(origin + slashes, path);
        expect(result).toBe(origin + path);
        expect(result.startsWith(origin + "//")).toBe(false);
      })
    );
  });

  it("is a no-op on an origin with no trailing slash", () => {
    fc.assert(
      fc.property(originArb, pathArb, (origin, path) => {
        expect(absoluteUrl(origin, path)).toBe(`${origin}${path}`);
      })
    );
  });
});
