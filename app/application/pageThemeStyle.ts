/**
 * Application layer: a page theme as CSS — the custom properties the page view
 * (webpage.css) reads, and the Google Fonts stylesheet its fonts need.
 * Shared by the editor (preview, slideshow) and the server-rendered page.
 */
import type { PageFont, PageTheme } from "../domain/pageTheme";

interface FontSpec {
  /** Google Fonts family name; null = the system font (nothing to load). */
  family: string | null;
  /** The `wght@` axis to request (absent: the family's only weight). */
  weights?: string;
  generic: "sans-serif" | "serif";
}

const SYSTEM_STACK = 'system-ui, -apple-system, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", Meiryo, sans-serif';

export const PAGE_FONTS: Record<PageFont, FontSpec> = {
  system: { family: null, generic: "sans-serif" },
  "noto-sans-jp": { family: "Noto Sans JP", weights: "400;700", generic: "sans-serif" },
  "noto-serif-jp": { family: "Noto Serif JP", weights: "400;700", generic: "serif" },
  "m-plus-rounded-1c": { family: "M PLUS Rounded 1c", weights: "400;700", generic: "sans-serif" },
  "zen-kaku-gothic-new": { family: "Zen Kaku Gothic New", weights: "400;700", generic: "sans-serif" },
  "zen-maru-gothic": { family: "Zen Maru Gothic", weights: "400;700", generic: "sans-serif" },
  "shippori-mincho": { family: "Shippori Mincho", weights: "400;700", generic: "serif" },
  "biz-udpgothic": { family: "BIZ UDPGothic", weights: "400;700", generic: "sans-serif" },
  "kosugi-maru": { family: "Kosugi Maru", generic: "sans-serif" },
};

/** The display name of a font choice (the system font is named by the caller, translated). */
export function fontFamilyName(font: PageFont): string | null {
  return PAGE_FONTS[font].family;
}

function fontStack(font: PageFont): string {
  const { family, generic } = PAGE_FONTS[font];
  return family ? `"${family}", ${generic === "serif" ? `"Hiragino Mincho ProN", serif` : SYSTEM_STACK}` : SYSTEM_STACK;
}

/** The Google Fonts stylesheet URL for the theme's fonts, or null when it uses none. */
export function googleFontsHref(theme: PageTheme): string | null {
  const families = [...new Set([theme.headingFont, theme.bodyFont])]
    .map((f) => PAGE_FONTS[f])
    .filter((f) => f.family)
    .map((f) => `family=${encodeURIComponent(f.family!).replace(/%20/g, "+")}${f.weights ? `:wght@${f.weights}` : ""}`);
  return families.length ? `https://fonts.googleapis.com/css2?${families.join("&")}&display=swap` : null;
}

/** The custom properties webpage.css reads, for a `style` attribute. */
export function themeVars(theme: PageTheme): Record<string, string> {
  return {
    "--wp-heading-font": fontStack(theme.headingFont),
    "--wp-body-font": fontStack(theme.bodyFont),
    "--wp-fg": theme.textColor,
    "--wp-accent": theme.accentColor,
    "--wp-bg": theme.background.colorA,
  };
}
