import { describe, it, expect, afterEach } from "vitest";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import {
  ACCENT_KEY,
  DEFAULT_ACCENT,
  getAccent,
  isAccentColor,
  loadAccent,
  setAccent,
  subscribeAccent,
  withAlpha,
} from "./accentColor";
import { memoryStorage } from "./browserStorage";

afterEach(() => setAccent(DEFAULT_ACCENT, undefined));

const hexArb = fc
  .array(fc.integer({ min: 0, max: 255 }), { minLength: 3, maxLength: 3 })
  .map((c) => "#" + c.map((n) => n.toString(16).padStart(2, "0")).join(""));

describe("accent color", () => {
  it("accepts only #rrggbb", () => {
    expect(isAccentColor("#10b981")).toBe(true);
    for (const bad of ["#10B981", "#fff", "10b981", "red", "#10b98", "", null, 1])
      expect(isAccentColor(bad)).toBe(false);
  });

  it("load(save(c)) round-trips and garbage falls back to the default", () => {
    fc.assert(
      fc.property(hexArb, (c) => {
        const s = memoryStorage();
        setAccent(c, s);
        expect(loadAccent(s)).toBe(c);
      })
    );
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const loaded = loadAccent(memoryStorage({ [ACCENT_KEY]: raw }));
        expect(isAccentColor(loaded)).toBe(true);
      })
    );
  });

  it("setAccent ignores invalid values and notifies only on change", () => {
    let n = 0;
    const off = subscribeAccent(() => n++);
    const s = memoryStorage();
    setAccent("nope", s);
    setAccent(DEFAULT_ACCENT, s);
    expect(n).toBe(0);
    setAccent("#112233", s);
    expect(n).toBe(1);
    expect(getAccent()).toBe("#112233");
    off();
  });

  it("withAlpha appends a clamped two-digit alpha", () => {
    expect(withAlpha("#10b981", 1)).toBe("#10b981ff");
    expect(withAlpha("#10b981", 0)).toBe("#10b98100");
    expect(withAlpha("#10b981", 2)).toBe("#10b981ff");
    fc.assert(
      fc.property(hexArb, fc.double({ min: 0, max: 1, noNaN: true }), (c, a) => {
        expect(withAlpha(c, a)).toMatch(/^#[0-9a-f]{8}$/);
      })
    );
  });
});

describe("styles.css", () => {
  it("declares the same default accent as DEFAULT_ACCENT (SSR paints the CSS one)", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    expect(css.match(/--accent:\s*(#[0-9a-f]{6})/)?.[1]).toBe(DEFAULT_ACCENT);
  });
});
