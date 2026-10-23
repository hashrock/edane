import { useCallback, useEffect, useRef, useState } from "react";
import {
  BACKGROUND_PRESET,
  DEFAULT_PAGE_THEME,
  HEADING_STYLE,
  MAX_SPEED,
  TITLE_STYLE,
  PAGE_FONT,
  SCROLL_EFFECT,
  effectiveTheme,
  rebaseTheme,
  type BackgroundPreset,
  type HeadingStyle,
  type TitleStyle,
  type PageFont,
  type PageTheme,
  type ScrollEffect,
} from "../domain/pageTheme";
import { fontFamilyName } from "../application/pageThemeStyle";
import type { MessageKey } from "../application/messages";
import { t } from "../application/i18n";
import { useLocale } from "./useLocale";

const PRESET_LABEL: Record<BackgroundPreset, MessageKey> = {
  none: "themeBgNone",
  gradient: "themeBgGradient",
  waves: "themeBgWaves",
  particles: "themeBgParticles",
  aurora: "themeBgAurora",
  silk: "themeBgSilk",
  haze: "themeBgHaze",
  contour: "themeBgContour",
  dust: "themeBgDust",
  shore: "themeBgShore",
  cloth: "themeBgCloth",
};

const HEADING_LABEL: Record<HeadingStyle, MessageKey> = {
  simple: "themeHeadingSimple",
  underline: "themeHeadingUnderline",
  bar: "themeHeadingBar",
  band: "themeHeadingBand",
  accent: "themeHeadingAccent",
};

/** A heading style in miniature, for its swatch (mirrors webpage.css's data-heading rules). */
function headingSample(style: HeadingStyle, accent: string): React.CSSProperties {
  switch (style) {
    case "underline":
      return { borderBottom: `2px solid ${accent}`, paddingBottom: 1 };
    case "bar":
      return { borderLeft: `3px solid ${accent}`, paddingLeft: 4 };
    case "band":
      return { background: `color-mix(in srgb, ${accent} 16%, transparent)`, padding: "1px 4px", borderRadius: 2 };
    case "accent":
      return { color: accent };
    case "simple":
      return {};
  }
}

const TITLE_LABEL: Record<TitleStyle, MessageKey> = {
  center: "themeTitleCenter",
  plain: "themeTitlePlain",
  left: "themeTitleLeft",
  large: "themeTitleLarge",
  frame: "themeTitleFrame",
  fill: "themeTitleFill",
};

/** A title page in miniature, for its swatch (mirrors webpage.css's data-title rules). */
function TitleSample({ style, theme }: { style: TitleStyle; theme: PageTheme }) {
  const fill = style === "fill";
  const fg = fill ? theme.background.colorA : theme.textColor;
  const rule = style === "center" || style === "left" || fill;
  return (
    <span
      aria-hidden="true"
      className={`flex aspect-video w-full flex-col gap-1 overflow-hidden rounded-sm p-1.5 ring-1 ring-slate-200 ${
        style === "left" ? "items-start justify-end" : "items-center justify-center"
      }`}
      style={{ background: fill ? theme.accentColor : theme.background.colorA }}
    >
      <span
        className="font-bold leading-none"
        style={{
          color: fg,
          fontSize: style === "large" ? 20 : 12,
          ...(style === "frame" ? { border: `1px solid ${theme.accentColor}`, padding: "1px 3px" } : {}),
        }}
      >
        Aa
      </span>
      {rule && <span className="h-px w-3.5" style={{ background: fill ? fg : theme.accentColor }} />}
    </span>
  );
}

const EFFECT_LABEL: Record<ScrollEffect, MessageKey> = {
  none: "themeEffectNone",
  "fade-up": "themeEffectFadeUp",
  slide: "themeEffectSlide",
  zoom: "themeEffectZoom",
};

/** Edits land in the document this long after the last change (one undo step, one sync commit). */
const COMMIT_DELAY = 250;

interface Props {
  /** Shown. Stays mounted while closed, so it slides in and out. */
  open: boolean;
  theme: PageTheme | undefined;
  /** Store a theme (null = back to the default). */
  onChange: (theme: PageTheme | null) => void;
  onClose: () => void;
  readOnly: boolean;
}

/**
 * ページモードの右サイドパネル: the note's page theme (fonts, title and
 * heading styles, colours, the WebGL background, scroll effect) — one theme for both formats,
 * the slides and the web page. A plain form beside the editor — it takes the
 * keyboard only when one of its own fields is clicked, and Escape closes it. It slides in from
 * the right edge and back out; closed, it is `invisible` (out of the tab
 * order and the accessibility tree) once the slide ends.
 */
export default function PageThemePanel({ open, theme, onChange, onClose, readOnly }: Props) {
  useLocale();
  // Follows `open` a frame late, so a panel mounted open still slides in.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setShown(open));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [open]);
  const stored = effectiveTheme(theme);
  const [draft, setDraft] = useState(stored);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<PageTheme | null>(null);
  /** The stored theme the pending edit (`latest`) started from. */
  const base = useRef<PageTheme | null>(null);
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (latest.current) onChangeRef.current(latest.current);
    latest.current = null;
    base.current = null;
  }, []);

  // A change from elsewhere (undo, another session) shows up; a pending edit of ours is replayed on top of it.
  useEffect(() => {
    const current = effectiveTheme(theme);
    if (latest.current && base.current) {
      latest.current = rebaseTheme(latest.current, base.current, current);
      base.current = current;
      setDraft(latest.current);
    } else setDraft(current);
  }, [theme]);
  useEffect(() => flush, [flush]);

  const update = (next: PageTheme) => {
    setDraft(next);
    if (!latest.current) base.current = effectiveTheme(themeRef.current);
    latest.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, COMMIT_DELAY);
  };
  const set = <K extends keyof PageTheme>(key: K, value: PageTheme[K]) => update({ ...draft, [key]: value });
  const setBg = <K extends keyof PageTheme["background"]>(key: K, value: PageTheme["background"][K]) =>
    update({ ...draft, background: { ...draft.background, [key]: value } });

  const fontLabel = (f: PageFont) => fontFamilyName(f) ?? t("themeSystemFont");
  const label = "block text-xs font-medium text-slate-500";
  const field = "mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-sm disabled:opacity-60";

  return (
    <aside
      data-testid="page-theme-panel"
      aria-label={t("pageThemeTitle")}
      data-open={shown ? "" : undefined}
      className={`fixed bottom-0 right-0 top-12 z-[60] flex w-80 max-w-full flex-col bg-white shadow-2xl ring-1 ring-slate-200 transition-[translate,visibility] duration-200 ease-out motion-reduce:transition-none ${
        shown ? "translate-x-0" : "invisible translate-x-[calc(100%+2rem)]"
      }`}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="flex items-center border-b border-slate-100 px-4 py-3">
        <h2 className="mr-auto text-sm font-semibold">{t("pageThemeTitle")}</h2>
        <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100">
          {t("close")}
        </button>
      </header>
      <fieldset disabled={readOnly} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t("themeFonts")}</h3>
          <label className={label}>
            {t("themeHeadingFont")}
            <select data-testid="theme-heading-font" className={field} value={draft.headingFont} onChange={(e) => set("headingFont", e.target.value as PageFont)}>
              {PAGE_FONT.values.map((f) => <option key={f} value={f}>{fontLabel(f)}</option>)}
            </select>
          </label>
          <label className={label}>
            {t("themeBodyFont")}
            <select data-testid="theme-body-font" className={field} value={draft.bodyFont} onChange={(e) => set("bodyFont", e.target.value as PageFont)}>
              {PAGE_FONT.values.map((f) => <option key={f} value={f}>{fontLabel(f)}</option>)}
            </select>
          </label>
        </section>

        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t("themeTitleStyle")}</h3>
          <div role="radiogroup" aria-label={t("themeTitleStyle")} className="grid grid-cols-3 gap-1.5">
            {TITLE_STYLE.values.map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={draft.titleStyle === v}
                data-testid={`theme-title-${v}`}
                onClick={() => set("titleStyle", v)}
                className={`flex flex-col items-center gap-1 rounded-md border p-1 text-[10px] text-slate-500 disabled:opacity-60 ${
                  draft.titleStyle === v ? "border-emerald-500 bg-emerald-50/60 text-emerald-700" : "border-slate-200 hover:bg-slate-50"
                }`}
              >
                <TitleSample style={v} theme={draft} />
                {t(TITLE_LABEL[v])}
              </button>
            ))}
          </div>
        </section>

        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t("themeHeadingStyle")}</h3>
          <div role="radiogroup" aria-label={t("themeHeadingStyle")} className="grid grid-cols-5 gap-1.5">
            {HEADING_STYLE.values.map((h) => (
              <button
                key={h}
                type="button"
                role="radio"
                aria-checked={draft.headingStyle === h}
                data-testid={`theme-heading-${h}`}
                onClick={() => set("headingStyle", h)}
                className={`flex flex-col items-center gap-1 rounded-md border px-1 py-1.5 text-[10px] text-slate-500 disabled:opacity-60 ${
                  draft.headingStyle === h ? "border-emerald-500 bg-emerald-50/60 text-emerald-700" : "border-slate-200 hover:bg-slate-50"
                }`}
              >
                <span className="text-sm font-bold leading-tight" style={{ color: draft.textColor, ...headingSample(h, draft.accentColor) }}>
                  Aa
                </span>
                {t(HEADING_LABEL[h])}
              </button>
            ))}
          </div>
        </section>

        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t("themeColors")}</h3>
          <div className="flex gap-3">
            <ColorField label={t("themeTextColor")} value={draft.textColor} onChange={(v) => set("textColor", v)} />
            <ColorField label={t("themeAccentColor")} value={draft.accentColor} onChange={(v) => set("accentColor", v)} />
          </div>
        </section>

        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t("themeBackground")}</h3>
          <label className={label}>
            {t("themeBgPreset")}
            <select data-testid="theme-bg-preset" className={field} value={draft.background.preset} onChange={(e) => setBg("preset", e.target.value as BackgroundPreset)}>
              {BACKGROUND_PRESET.values.map((p) => <option key={p} value={p}>{t(PRESET_LABEL[p])}</option>)}
            </select>
          </label>
          <div className="flex gap-3">
            <ColorField label={t("themeBgColorA")} value={draft.background.colorA} onChange={(v) => setBg("colorA", v)} />
            <ColorField label={t("themeBgColorB")} value={draft.background.colorB} onChange={(v) => setBg("colorB", v)} />
          </div>
          <label className={label}>
            {t("themeBgSpeed")}
            <input type="range" min={0} max={MAX_SPEED} step={0.1} className="mt-1 w-full" value={draft.background.speed} onChange={(e) => setBg("speed", Number(e.target.value))} />
          </label>
          <label className={label}>
            {t("themeBgParallax")}
            <input type="range" min={0} max={1} step={0.05} className="mt-1 w-full" value={draft.background.parallax} onChange={(e) => setBg("parallax", Number(e.target.value))} />
          </label>
        </section>

        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t("themeScroll")}</h3>
          <select data-testid="theme-scroll-effect" aria-label={t("themeScroll")} className={field} value={draft.scrollEffect} onChange={(e) => set("scrollEffect", e.target.value as ScrollEffect)}>
            {SCROLL_EFFECT.values.map((v) => <option key={v} value={v}>{t(EFFECT_LABEL[v])}</option>)}
          </select>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={draft.stagger} onChange={(e) => set("stagger", e.target.checked)} />
            {t("themeStagger")}
          </label>
        </section>

        <button
          type="button"
          data-testid="theme-reset"
          className="text-xs text-slate-500 underline hover:text-slate-700"
          onClick={() => {
            if (timer.current) clearTimeout(timer.current);
            timer.current = null;
            latest.current = null;
            base.current = null;
            setDraft(DEFAULT_PAGE_THEME);
            onChange(null);
          }}
        >
          {t("themeReset")}
        </button>
      </fieldset>
    </aside>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-1 items-center gap-2 text-xs text-slate-500">
      <input type="color" className="h-7 w-9 cursor-pointer rounded border border-slate-200 bg-white p-0.5" value={value} onChange={(e) => onChange(e.target.value)} />
      {label}
    </label>
  );
}
