/**
 * publicNoteUrl: for any note id the URL parses back to the same origin and a
 * `/notes/<id>` path whose decoded segment is exactly the id (so no id can
 * break out of the path), and trailing slashes on the origin never matter.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { publicNoteUrl } from "./publicNoteLink";

const originArb = fc.constantFrom(
  "https://edane.example",
  "http://localhost:5173"
);
const slashesArb = fc.nat(3).map((n) => "/".repeat(n));

describe("publicNoteUrl properties", () => {
  it("round-trips any id through the URL path", () => {
    fc.assert(
      fc.property(originArb, fc.string({ unit: "binary-ascii" }), (origin, id) => {
        const url = new URL(publicNoteUrl(origin, id));
        expect(url.origin).toBe(origin);
        expect(url.search).toBe("");
        expect(url.hash).toBe("");
        const segments = url.pathname.split("/");
        expect(segments.slice(0, 2)).toEqual(["", "notes"]);
        expect(segments).toHaveLength(3);
        expect(decodeURIComponent(segments[2])).toBe(id);
      })
    );
  });

  it("ignores trailing slashes on the origin", () => {
    fc.assert(
      fc.property(originArb, slashesArb, fc.string(), (origin, slashes, id) => {
        expect(publicNoteUrl(origin + slashes, id)).toBe(publicNoteUrl(origin, id));
      })
    );
  });
});
