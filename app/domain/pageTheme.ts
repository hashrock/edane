/**
 * Domain: the note's page theme (Webページモード / プレゼンモード共通の見た目).
 *
 * A theme is document data — it lives in the note's content JSON next to the
 * trees (`MindMapDocument.theme`), so it syncs, undoes and is encrypted like
 * any other edit, and a public note's server can read it to render the
 * published page. Absent = {@link DEFAULT_PAGE_THEME}, which draws exactly
 * the plain white slide the presentation mode always had.
 *
 * Every field is a closed choice or a bounded value: the theme is untrusted
 * input (the DB, the sync wire) and {@link normalizePageTheme} is the one
 * gate that turns any JSON into a well-formed theme.
 */
import { closedStringSet } from "./isKeyOf";

export const PAGE_FONT = closedStringSet({
  system: true,
  "noto-sans-jp": true,
  "noto-serif-jp": true,
  "m-plus-rounded-1c": true,
  "zen-kaku-gothic-new": true,
  "zen-maru-gothic": true,
  "shippori-mincho": true,
  "biz-udpgothic": true,
  "kosugi-maru": true,
} as const);
export type PageFont = (typeof PAGE_FONT.values)[number];

export const BACKGROUND_PRESET = closedStringSet({
  none: true,
  gradient: true,
  waves: true,
  particles: true,
  aurora: true,
  silk: true,
  haze: true,
  contour: true,
  dust: true,
  shore: true,
  cloth: true,
} as const);
export type BackgroundPreset = (typeof BACKGROUND_PRESET.values)[number];

export const SCROLL_EFFECT = closedStringSet({
  none: true,
  "fade-up": true,
  slide: true,
  zoom: true,
} as const);
export type ScrollEffect = (typeof SCROLL_EFFECT.values)[number];

/** The animated background behind the pages. */
export interface PageBackground {
  preset: BackgroundPreset;
  /** `#rrggbb`. The base colour (the whole background when `preset` is none). */
  colorA: string;
  /** `#rrggbb`. The second colour the preset blends in. */
  colorB: string;
  /** Animation speed, 0 (still) – {@link MAX_SPEED}. */
  speed: number;
  /** How far the background follows the scroll, 0 (fixed) – 1 (scrolls with the page). */
  parallax: number;
}

export interface PageTheme {
  headingFont: PageFont;
  bodyFont: PageFont;
  /** `#rrggbb` text colour. */
  textColor: string;
  /** `#rrggbb` accent (bullets, rules, links). */
  accentColor: string;
  background: PageBackground;
  /** How a page enters the screen while scrolling the web page. */
  scrollEffect: ScrollEffect;
  /** Items of a page appear one after another. */
  stagger: boolean;
  /** Author CSS, scoped to the page (see application/scopedCss.ts). */
  css: string;
}

export const MAX_SPEED = 3;
export const MAX_THEME_CSS = 20_000;

export const DEFAULT_PAGE_THEME: PageTheme = {
  headingFont: "system",
  bodyFont: "system",
  textColor: "#0f172a",
  accentColor: "#10b981",
  background: { preset: "none", colorA: "#ffffff", colorB: "#d1fae5", speed: 1, parallax: 0.3 },
  scrollEffect: "fade-up",
  stagger: true,
  css: "",
};

const HEX = /^#[0-9a-f]{6}$/;

function color(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const v = value.toLowerCase();
  return HEX.test(v) ? v : fallback;
}

function bounded(value: unknown, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(0, value)) : fallback;
}

/**
 * Any value → a complete theme, each invalid or missing field replaced by its
 * default. Null when the value isn't an object at all (= no theme).
 * Idempotent: a normalized theme normalizes to an equal one.
 */
export function normalizePageTheme(value: unknown): PageTheme | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const d = DEFAULT_PAGE_THEME;
  const bg = (v.background && typeof v.background === "object" ? v.background : {}) as Record<string, unknown>;
  return {
    headingFont: PAGE_FONT.is(v.headingFont) ? v.headingFont : d.headingFont,
    bodyFont: PAGE_FONT.is(v.bodyFont) ? v.bodyFont : d.bodyFont,
    textColor: color(v.textColor, d.textColor),
    accentColor: color(v.accentColor, d.accentColor),
    background: {
      preset: BACKGROUND_PRESET.is(bg.preset) ? bg.preset : d.background.preset,
      colorA: color(bg.colorA, d.background.colorA),
      colorB: color(bg.colorB, d.background.colorB),
      speed: bounded(bg.speed, MAX_SPEED, d.background.speed),
      parallax: bounded(bg.parallax, 1, d.background.parallax),
    },
    scrollEffect: SCROLL_EFFECT.is(v.scrollEffect) ? v.scrollEffect : d.scrollEffect,
    stagger: typeof v.stagger === "boolean" ? v.stagger : d.stagger,
    css: typeof v.css === "string" ? v.css.slice(0, MAX_THEME_CSS) : d.css,
  };
}

/** The theme a document is drawn with. */
export function effectiveTheme(theme: PageTheme | undefined): PageTheme {
  return theme ?? DEFAULT_PAGE_THEME;
}

/**
 * `current` with the fields `edit` changed from `base` — the pending edit
 * replayed on a theme that changed meanwhile (undo, another session), so it
 * doesn't put back what that change replaced.
 */
export function rebaseTheme(edit: PageTheme, base: PageTheme, current: PageTheme): PageTheme {
  const pick = <T extends object>(e: T, b: T, c: T): T => {
    const out = { ...c };
    for (const k of Object.keys(e) as (keyof T)[]) if (e[k] !== b[k]) out[k] = e[k];
    return out;
  };
  return { ...pick(edit, base, current), background: pick(edit.background, base.background, current.background) };
}
