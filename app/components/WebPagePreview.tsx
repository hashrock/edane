import { useMemo, useState } from "react";
import type { MindMapDocument } from "../domain/model";
import { effectiveTheme } from "../domain/pageTheme";
import { buildSlides, slideIndexOf } from "../application/slides";
import { t } from "../application/i18n";
import { useLocale } from "./useLocale";
import { PageBackground, PageRoot, PageSection, PageThemeAssets } from "./PageView";

/** The page is laid out at this size and scaled down, so it looks like the real page. */
const VIRTUAL_WIDTH = 1280;
const VIRTUAL_HEIGHT = 720;
const SCALE = 0.25;

interface Props {
  doc: MindMapDocument;
  /** The selected node; the preview shows the page that presents it. */
  activeNodeId: string | null;
  onOpenTheme?: () => void;
  onExit: () => void;
}

/**
 * Webページモード: the page the selected node is on, as the published web page
 * draws it (PageView variant `web`), small in the editor's top-right corner.
 * Follows the selection and every edit live. It never takes the keyboard.
 */
export default function WebPagePreview({ doc, activeNodeId, onOpenTheme, onExit }: Props) {
  useLocale();
  const [open, setOpen] = useState(true);
  const slides = useMemo(() => buildSlides(doc), [doc]);
  const index = slideIndexOf(slides, doc, activeNodeId);
  const slide = slides[index];
  const theme = effectiveTheme(doc.theme);
  const button = "rounded-md px-1.5 py-0.5 text-[11px] text-slate-600 hover:bg-slate-100";

  return (
    <div
      data-testid="webpage-preview"
      className="pointer-events-auto rounded-xl bg-white/95 p-1.5 shadow-lg ring-1 ring-slate-200 backdrop-blur"
      style={{ width: VIRTUAL_WIDTH * SCALE + 12 }}
    >
      <div className="flex items-center gap-1 px-0.5 pb-1">
        <span data-testid="webpage-preview-counter" className="mr-auto text-[11px] tabular-nums text-slate-500">
          {slides.length ? t("webPagePageOf", { n: String(index + 1), total: String(slides.length) }) : t("presentEmpty")}
        </span>
        {onOpenTheme && (
          <button type="button" data-testid="webpage-theme-open" className={button} onClick={onOpenTheme}>
            {t("webPageTheme")}
          </button>
        )}
        <button
          type="button"
          className={button}
          aria-expanded={open}
          title={open ? t("webPageHidePreview") : t("webPageShowPreview")}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "▴" : "▾"}
        </button>
        <button type="button" className={button} title={t("webPageExit")} aria-label={t("webPageExit")} onClick={onExit}>
          ✕
        </button>
      </div>
      {open && (
        <div
          role="img"
          aria-label={t("webPagePreview")}
          className="wp-frame rounded-md ring-1 ring-slate-200"
          style={{ width: VIRTUAL_WIDTH * SCALE, height: VIRTUAL_HEIGHT * SCALE }}
        >
          <PageThemeAssets theme={theme} />
          <PageRoot
            theme={theme}
            variant="web"
            testId="webpage-preview-page"
            style={{
              width: VIRTUAL_WIDTH,
              height: VIRTUAL_HEIGHT,
              minHeight: 0,
              overflow: "hidden",
              transform: `scale(${SCALE})`,
              transformOrigin: "0 0",
              ["--wp-page-h" as string]: `${VIRTUAL_HEIGHT}px`,
            }}
          >
            {/* The background is where it would be with this page on screen. */}
            <PageBackground background={theme.background} scrollY={() => index * VIRTUAL_HEIGHT} scrollKey={index} resolution={SCALE * 2} />
            {slide && <PageSection slide={slide} index={index} />}
          </PageRoot>
        </div>
      )}
    </div>
  );
}
