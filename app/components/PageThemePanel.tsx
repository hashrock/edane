import { useCallback, useEffect, useRef, useState } from "react";
import {
  BACKGROUND_PRESET,
  DEFAULT_PAGE_THEME,
  MAX_SPEED,
  MAX_THEME_CSS,
  PAGE_FONT,
  SCROLL_EFFECT,
  effectiveTheme,
  type BackgroundPreset,
  type PageFont,
  type PageTheme,
  type ScrollEffect,
} from "../domain/pageTheme";
import { fontFamilyName } from "../application/pageThemeStyle";
import { webPageUrl, type WebPagePublicationStatus } from "../application/webPagePublication";
import type { MessageKey } from "../application/messages";
import { t } from "../application/i18n";
import { copyText } from "../lib/clipboard";
import { useLocale } from "./useLocale";

const PRESET_LABEL: Record<BackgroundPreset, MessageKey> = {
  none: "themeBgNone",
  gradient: "themeBgGradient",
  waves: "themeBgWaves",
  particles: "themeBgParticles",
  aurora: "themeBgAurora",
};

const EFFECT_LABEL: Record<ScrollEffect, MessageKey> = {
  none: "themeEffectNone",
  "fade-up": "themeEffectFadeUp",
  slide: "themeEffectSlide",
  zoom: "themeEffectZoom",
};

/** Edits land in the document this long after the last change (one undo step, one sync commit). */
const COMMIT_DELAY = 250;

interface Props {
  theme: PageTheme | undefined;
  /** Store a theme (null = back to the default). */
  onChange: (theme: PageTheme | null) => void;
  onClose: () => void;
  readOnly: boolean;
  /** The saved note; absent for a guest note (nothing to publish). */
  noteId?: string;
  isPublic: boolean;
}

/**
 * Webページモードの右サイドパネル: the note's page theme (fonts, colours, the
 * WebGL background, scroll effect, author CSS) and publishing the note as a
 * web page. A plain form beside the editor — it takes the keyboard only when
 * one of its own fields is clicked, and Escape closes it.
 */
export default function PageThemePanel({ theme, onChange, onClose, readOnly, noteId, isPublic }: Props) {
  useLocale();
  const stored = effectiveTheme(theme);
  const [draft, setDraft] = useState(stored);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<PageTheme | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (latest.current) onChangeRef.current(latest.current);
    latest.current = null;
  }, []);

  // A change from elsewhere (undo, another session) shows up unless one of ours is pending.
  useEffect(() => {
    if (!timer.current) setDraft(effectiveTheme(theme));
  }, [theme]);
  useEffect(() => flush, [flush]);

  const update = (next: PageTheme) => {
    setDraft(next);
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
      aria-label={t("webPageThemeTitle")}
      className="fixed bottom-0 right-0 top-12 z-[60] flex w-80 max-w-full flex-col bg-white shadow-2xl ring-1 ring-slate-200"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="flex items-center border-b border-slate-100 px-4 py-3">
        <h2 className="mr-auto text-sm font-semibold">{t("webPageThemeTitle")}</h2>
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

        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t("themeCss")}</h3>
          <textarea
            data-testid="theme-css"
            aria-label={t("themeCss")}
            spellCheck={false}
            maxLength={MAX_THEME_CSS}
            rows={8}
            className={`${field} font-mono text-xs`}
            placeholder={".wp-heading {\n  letter-spacing: 0.05em;\n}"}
            value={draft.css}
            onChange={(e) => set("css", e.target.value)}
          />
          <p className="text-[11px] leading-snug text-slate-400">{t("themeCssHint")}</p>
        </section>

        <button
          type="button"
          data-testid="theme-reset"
          className="text-xs text-slate-500 underline hover:text-slate-700"
          onClick={() => {
            if (timer.current) clearTimeout(timer.current);
            timer.current = null;
            latest.current = null;
            setDraft(DEFAULT_PAGE_THEME);
            onChange(null);
          }}
        >
          {t("themeReset")}
        </button>
      </fieldset>
      {noteId && !readOnly && <PublishSection noteId={noteId} isPublic={isPublic} />}
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

async function webPageApi(noteId: string, method: "GET" | "POST" | "DELETE"): Promise<WebPagePublicationStatus | null> {
  const res = await fetch(`/api/notes/${encodeURIComponent(noteId)}/webpage`, { method, credentials: "include" });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || t("webPublishFailed"));
  const body = (await res.json()) as { publication?: WebPagePublicationStatus | null };
  return body.publication ?? null;
}

/** Publish / unpublish the note as a web page (`/w/:id`). */
function PublishSection({ noteId, isPublic }: { noteId: string; isPublic: boolean }) {
  const [status, setStatus] = useState<WebPagePublicationStatus | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    webPageApi(noteId, "GET").then(
      (s) => live && setStatus(s),
      (e: Error) => live && setError(e.message)
    );
    return () => {
      live = false;
    };
  }, [noteId, isPublic]);

  const run = async (method: "POST" | "DELETE") => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await webPageApi(noteId, method));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const url = status ? webPageUrl(window.location.origin, status.id) : null;
  const button = "rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50";

  return (
    <section data-testid="webpage-publish" className="space-y-2 border-t border-slate-100 px-4 py-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t("webPublish")}</h3>
      {!isPublic ? (
        <p className="text-xs text-slate-500">{t("webPublishPrivate")}</p>
      ) : status === undefined && !error ? (
        <p className="text-xs text-slate-400">{t("loading")}</p>
      ) : status && url ? (
        <>
          <div className="flex items-center gap-1">
            <input readOnly aria-label="URL" data-testid="webpage-url" value={url} className="min-w-0 flex-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs" onFocus={(e) => e.currentTarget.select()} />
            <button
              type="button"
              className={`${button} text-slate-600 hover:bg-slate-100`}
              onClick={() => {
                void copyText(url).then(() => setCopied(true));
              }}
            >
              {copied ? t("copied") : t("copy")}
            </button>
            <a href={url} target="_blank" rel="noopener noreferrer" className={`${button} text-emerald-700 hover:bg-emerald-50`}>
              {t("webPublishOpen")}
            </a>
          </div>
          <p className="text-[11px] text-slate-400">{status.active ? t("webPublishLive") : t("webPublishInactive")}</p>
          <div className="flex gap-2">
            {!status.active && (
              <button type="button" disabled={busy} className={`${button} bg-emerald-600 text-white hover:bg-emerald-700`} onClick={() => void run("POST")}>
                {t("webPublishAction")}
              </button>
            )}
            <button type="button" disabled={busy} data-testid="webpage-unpublish" className={`${button} text-red-600 hover:bg-red-50`} onClick={() => void run("DELETE")}>
              {t("webPublishUnpublish")}
            </button>
          </div>
        </>
      ) : (
        <button type="button" disabled={busy} data-testid="webpage-publish-action" className={`${button} bg-emerald-600 text-white hover:bg-emerald-700`} onClick={() => void run("POST")}>
          {t("webPublishAction")}
        </button>
      )}
      {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
    </section>
  );
}
