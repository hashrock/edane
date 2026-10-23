import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  BACKGROUND_PRESET,
  DEFAULT_PAGE_THEME,
  MAX_SPEED,
  MAX_THEME_CSS,
  PAGE_FONT,
  SCROLL_EFFECT,
  normalizePageTheme,
  rebaseTheme,
  type PageTheme,
} from "./pageTheme";
import { pageThemeArb } from "./model.arb";

const HEX = /^#[0-9a-f]{6}$/;

function expectWellFormed(theme: PageTheme) {
  expect(PAGE_FONT.is(theme.headingFont)).toBe(true);
  expect(PAGE_FONT.is(theme.bodyFont)).toBe(true);
  expect(theme.textColor).toMatch(HEX);
  expect(theme.accentColor).toMatch(HEX);
  expect(BACKGROUND_PRESET.is(theme.background.preset)).toBe(true);
  expect(theme.background.colorA).toMatch(HEX);
  expect(theme.background.colorB).toMatch(HEX);
  expect(theme.background.speed).toBeGreaterThanOrEqual(0);
  expect(theme.background.speed).toBeLessThanOrEqual(MAX_SPEED);
  expect(theme.background.parallax).toBeGreaterThanOrEqual(0);
  expect(theme.background.parallax).toBeLessThanOrEqual(1);
  expect(SCROLL_EFFECT.is(theme.scrollEffect)).toBe(true);
  expect(typeof theme.stagger).toBe("boolean");
  expect(theme.css.length).toBeLessThanOrEqual(MAX_THEME_CSS);
}

/** A theme-shaped object whose fields may be anything. */
const looseThemeArb = fc.record(
  {
    headingFont: fc.oneof(fc.constantFrom(...PAGE_FONT.values), fc.anything()),
    bodyFont: fc.anything(),
    textColor: fc.oneof(fc.constantFrom("#ABCDEF", "#123", "red"), fc.anything()),
    accentColor: fc.anything(),
    background: fc.oneof(
      fc.record(
        {
          preset: fc.oneof(fc.constantFrom(...BACKGROUND_PRESET.values, "constructor"), fc.anything()),
          colorA: fc.anything(),
          colorB: fc.anything(),
          speed: fc.oneof(fc.double(), fc.anything()),
          parallax: fc.oneof(fc.double(), fc.anything()),
        },
        { requiredKeys: [] }
      ),
      fc.anything()
    ),
    scrollEffect: fc.anything(),
    stagger: fc.anything(),
    css: fc.oneof(fc.string(), fc.anything()),
  },
  { requiredKeys: [] }
);

describe("normalizePageTheme", () => {
  it("turns any theme-shaped value into a well-formed theme, idempotently", () => {
    fc.assert(
      fc.property(looseThemeArb, (value) => {
        const once = normalizePageTheme(value)!;
        expectWellFormed(once);
        expect(normalizePageTheme(once)).toEqual(once);
      })
    );
  });

  it("is null for anything that isn't an object", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.double(), fc.boolean(), fc.constant(null), fc.array(fc.anything())), (value) => {
        expect(normalizePageTheme(value)).toBeNull();
      })
    );
  });

  it("keeps every well-formed theme as it is", () => {
    fc.assert(
      fc.property(pageThemeArb, (theme) => {
        expect(normalizePageTheme(theme)).toEqual(theme);
      })
    );
  });

  it("fills missing fields from the default", () => {
    expect(normalizePageTheme({})).toEqual(DEFAULT_PAGE_THEME);
    expect(normalizePageTheme({ background: { preset: "waves" } })!.background).toEqual({ ...DEFAULT_PAGE_THEME.background, preset: "waves" });
  });
});

describe("rebaseTheme", () => {
  it("keeps what changed meanwhile and replays only the edited fields", () => {
    const base = DEFAULT_PAGE_THEME;
    const edit: PageTheme = { ...base, accentColor: "#ff0000", background: { ...base.background, speed: 0 } };
    const current: PageTheme = { ...base, css: ".wp-heading { color: red; }", background: { ...base.background, colorA: "#000000" } };
    expect(rebaseTheme(edit, base, current)).toEqual({
      ...current,
      accentColor: "#ff0000",
      background: { ...current.background, speed: 0 },
    });
  });

  it("is the edit when nothing changed meanwhile", () => {
    const edit: PageTheme = { ...DEFAULT_PAGE_THEME, stagger: !DEFAULT_PAGE_THEME.stagger, css: "x" };
    expect(rebaseTheme(edit, DEFAULT_PAGE_THEME, DEFAULT_PAGE_THEME)).toEqual(edit);
  });
});
