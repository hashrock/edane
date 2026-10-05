/**
 * Accent colour: `isAccentColor` is exactly the `#rrggbb` lowercase form,
 * `withAlpha` keeps the base colour and appends a clamped, monotone alpha byte,
 * and `loadAccent` never returns anything `isAccentColor` rejects.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  ACCENT_KEY,
  DEFAULT_ACCENT,
  isAccentColor,
  loadAccent,
  withAlpha,
} from "./accentColor";
import { memoryStorage } from "./browserStorage";

const hexArb = fc
  .array(fc.constantFrom(..."0123456789abcdef"), { minLength: 6, maxLength: 6 })
  .map((d) => `#${d.join("")}`);

describe("accent color properties", () => {
  it("isAccentColor accepts every lowercase #rrggbb and rejects uppercase / other lengths", () => {
    fc.assert(
      fc.property(hexArb, (hex) => {
        expect(isAccentColor(hex)).toBe(true);
        expect(isAccentColor(hex.toUpperCase())).toBe(hex === hex.toUpperCase());
        expect(isAccentColor(hex + "0")).toBe(false);
        expect(isAccentColor(hex.slice(0, -1))).toBe(false);
      })
    );
  });

  it("withAlpha keeps the base colour, appends one byte, and is monotone in alpha", () => {
    fc.assert(
      fc.property(hexArb, fc.double({ noNaN: true }), fc.double({ noNaN: true }), (hex, a, b) => {
        const x = withAlpha(hex, a);
        expect(x).toMatch(/^#[0-9a-f]{8}$/);
        expect(x.startsWith(hex)).toBe(true);
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(parseInt(withAlpha(hex, lo).slice(7), 16)).toBeLessThanOrEqual(
          parseInt(withAlpha(hex, hi).slice(7), 16)
        );
      })
    );
  });

  it("loadAccent returns the stored value iff valid, else the default", () => {
    fc.assert(
      fc.property(fc.oneof(hexArb, fc.string()), (raw) => {
        const got = loadAccent(memoryStorage({ [ACCENT_KEY]: raw }));
        expect(got).toBe(isAccentColor(raw) ? raw : DEFAULT_ACCENT);
      })
    );
  });
});
