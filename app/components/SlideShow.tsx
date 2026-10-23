import { useEffect, useMemo, useState } from "react";
import type { MindMapDocument } from "../domain/model";
import { effectiveTheme } from "../domain/pageTheme";
import { buildSlides, slideIndexOf, type Slide } from "../application/slides";
import { t } from "../application/i18n";
import { renderMarkdownHtml } from "../lib/markdownHtml";
import { PageBackground, PageContentContext, PageRoot, PageSection, PageThemeAssets, type PageContentPolicy } from "./PageView";

/** The slideshow renders content as the editor does (it is never server-rendered). */
const SLIDESHOW_CONTENT: PageContentPolicy = { markdownHtml: renderMarkdownHtml, imageSrc: (raw) => raw || null };

interface Props {
  doc: MindMapDocument;
  /** Node to start from (the editor's selection); its slide opens first. */
  startNodeId: string | null;
  /** Leave the show; hands back the heading of the slide on screen. */
  onExit: (nodeId: string | null) => void;
}

const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"]);
const PREV_KEYS = new Set(["ArrowLeft", "ArrowUp", "PageUp", "Backspace"]);

/**
 * Full-screen presentation of the document (see application/slides.ts for
 * how the tree becomes slides), drawn with the note's page theme by the
 * shared page view (PageView.tsx, variant `slide`): a 16:9 size container,
 * so the slide looks the same at any window size.
 *
 * Keys are taken in the capture phase and stopped there, so the editor
 * underneath never sees them while the show is up.
 */
export default function SlideShow({ doc, startNodeId, onExit }: Props) {
  const slides = useMemo(() => buildSlides(doc), [doc]);
  const [index, setIndex] = useState(() => slideIndexOf(slides, doc, startNodeId));
  const slide: Slide | undefined = slides[index];
  const last = slides.length - 1;
  const go = (to: number) => setIndex(Math.max(0, Math.min(to, last)));
  const exit = () => onExit(slide?.heading.id ?? null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") exit();
      else if (NEXT_KEYS.has(e.key)) go(index + 1);
      else if (PREV_KEYS.has(e.key)) go(index - 1);
      else if (e.key === "Home") go(0);
      else if (e.key === "End") go(last);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  // Clicking the right two thirds advances, the left third goes back —
  // except on links, which keep their own click.
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("a")) return;
    const { left, width } = e.currentTarget.getBoundingClientRect();
    go(e.clientX - left < width / 3 ? index - 1 : index + 1);
  };

  const theme = effectiveTheme(doc.theme);

  return (
    <div
      role="dialog"
      aria-label={t("presentTitle")}
      data-testid="slideshow"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950"
    >
      <PageThemeAssets theme={theme} />
      <div
        data-testid="slide"
        onClick={onClick}
        style={{ width: "min(100vw, calc(100vh * 16 / 9))" }}
        className="wp-frame relative aspect-video cursor-pointer"
      >
        <PageRoot theme={theme} variant="slide" className="h-full w-full">
          <PageBackground background={theme.background} />
          {slide ? (
            <PageContentContext.Provider value={SLIDESHOW_CONTENT}>
              <PageSection slide={slide} index={index} />
            </PageContentContext.Provider>
          ) : (
            <p className="relative flex h-full items-center justify-center text-[3cqw] opacity-50">
              {t("presentEmpty")}
            </p>
          )}
        </PageRoot>
        {slide && (
          <>
            <div
              className="absolute inset-x-0 bottom-0 h-[0.4%] min-h-[2px] transition-[width]"
              style={{ width: `${((index + 1) / slides.length) * 100}%`, background: theme.accentColor }}
            />
            <span
              data-testid="slide-counter"
              className="absolute bottom-[2.5%] right-[1.5%] text-xs tabular-nums opacity-50"
              style={{ color: theme.textColor }}
            >
              {index + 1} / {slides.length}
            </span>
          </>
        )}
      </div>
      <button
        type="button"
        onClick={exit}
        className="absolute right-4 top-4 rounded-lg px-3 py-1.5 text-xs text-slate-400 hover:bg-white/10 hover:text-white"
      >
        {t("presentExit")}
      </button>
    </div>
  );
}
