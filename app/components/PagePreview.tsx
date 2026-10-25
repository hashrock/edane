import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { findNode, type MindMapDocument } from "../domain/model";
import type { PageTheme } from "../domain/pageTheme";
import { effectiveTheme } from "../domain/pageTheme";
import { branchSlideIndices, buildSlides, slideIndexOf, splittable, type Slide } from "../application/slides";
import {
  DEFAULT_PREVIEW_SCALE,
  PREVIEW_VIRTUAL_HEIGHT as VIRTUAL_HEIGHT,
  PREVIEW_VIRTUAL_WIDTH as VIRTUAL_WIDTH,
  loadPreviewScale,
  resizedPreviewScale,
  savePreviewScale,
  type PreviewResizeEdge,
} from "../application/pagePreviewSize";
import { t } from "../application/i18n";
import type { MessageKey } from "../application/messages";
import { useLocale } from "./useLocale";
import { PlayIcon } from "./icons";
import PagePublish from "./PagePublish";
import { PageBackground, PageRoot, PageSection, PageThemeAssets, type PageVariant } from "./PageView";

interface Choice<T> {
  value: T;
  /** Suffix of the button's test id. */
  id: string;
  label: MessageKey;
  hint?: MessageKey;
}

const FORMATS: Choice<PageVariant>[] = [
  { value: "slide", id: "slide", label: "pageFormatSlide" },
  { value: "web", id: "web", label: "pageFormatWeb" },
];

/** `MindMapModel.slideSplit`: automatic (absent), a slide per child, or one list. */
const SPLITS: Choice<boolean | null>[] = [
  { value: null, id: "auto", label: "pageSplitAuto", hint: "pageSplitAutoHint" },
  { value: true, id: "each", label: "pageSplitEach", hint: "pageSplitEachHint" },
  { value: false, id: "list", label: "pageSplitList", hint: "pageSplitListHint" },
];

/** A small segmented control: one radio button per choice. */
function Segmented<T>({ label, testId, choices, value, onChange, className = "" }: {
  label: string;
  testId: string;
  choices: Choice<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} data-testid={testId} className={`flex rounded-md bg-slate-100 p-0.5 ${className}`}>
      {choices.map((c) => {
        const on = c.value === value;
        return (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={on}
            data-testid={`${testId}-${c.id}`}
            title={c.hint && t(c.hint)}
            onClick={() => onChange(c.value)}
            className={`rounded px-2 py-0.5 text-[11px] ${on ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
          >
            {t(c.label)}
          </button>
        );
      })}
    </div>
  );
}

/** How long the split overview stays after the choice changes. */
const OVERVIEW_MS = 3000;
/** Thumbnails the overview draws at most; the rest are counted. */
const OVERVIEW_MAX = 16;

/**
 * Every page of a branch at once, as numbered thumbnails over the preview:
 * what a split choice just did, before the preview goes back to the one page.
 * Clicking it dismisses it early.
 */
function SplitOverview({ slides, indices, theme, width, height, onDismiss }: {
  slides: Slide[];
  indices: number[];
  theme: PageTheme;
  width: number;
  height: number;
  onDismiss: () => void;
}) {
  const shown = indices.slice(0, OVERVIEW_MAX);
  const cols = Math.ceil(Math.sqrt(shown.length));
  const rows = Math.ceil(shown.length / cols);
  const gap = 4;
  const scale = Math.min(
    (width - gap * (cols + 1)) / cols / VIRTUAL_WIDTH,
    (height - gap * (rows + 1)) / rows / VIRTUAL_HEIGHT
  );
  return (
    <div
      data-testid="page-split-overview"
      aria-label={t("pageSplitOverview", { n: String(indices.length) })}
      onClick={onDismiss}
      className="absolute inset-0 z-10 flex cursor-pointer flex-wrap content-center justify-center bg-slate-700 motion-safe:animate-[wp-overview-in_150ms_ease-out]"
      style={{ gap, padding: gap }}
    >
      {shown.map((i, k) => (
        <div
          key={i}
          data-testid="page-split-overview-page"
          className="relative overflow-hidden rounded-sm ring-1 ring-white/40"
          style={{ width: VIRTUAL_WIDTH * scale, height: VIRTUAL_HEIGHT * scale }}
        >
          <PageRoot
            theme={theme}
            variant="slide"
            style={{
              width: VIRTUAL_WIDTH,
              height: VIRTUAL_HEIGHT,
              minHeight: 0,
              overflow: "hidden",
              transform: `scale(${scale})`,
              transformOrigin: "0 0",
              ["--wp-page-h" as string]: `${VIRTUAL_HEIGHT}px`,
            }}
          >
            <PageSection slide={slides[i]} index={i} />
          </PageRoot>
          <span className="absolute bottom-0.5 right-0.5 rounded bg-emerald-600 px-1 text-[10px] font-medium leading-4 tabular-nums text-white">
            {k === shown.length - 1 && indices.length > shown.length ? `${k + 1}…${indices.length}` : k + 1}
          </span>
        </div>
      ))}
    </div>
  );
}

interface Props {
  doc: MindMapDocument;
  /** The selected node; the preview shows the page that presents it. */
  activeNodeId: string | null;
  /** Which format the preview draws the page in: one 16:9 slide, or a screen of the web page. */
  format: PageVariant;
  onFormatChange: (format: PageVariant) => void;
  /** Start the slideshow from the selected node (the slides' action). */
  onPresent: () => void;
  /** Publishing as a web page (the web page's action). Absent = can't publish here (a guest or read-only note). */
  publish?: { noteId: string; isPublic: boolean };
  onOpenTheme?: () => void;
  /** Set how the selected node's branch is split into slides (`null` = automatic). Absent = read-only. */
  onSlideSplit?: (nodeId: string, split: boolean | null) => void;
  onExit: () => void;
}

/**
 * ページモード: the page the selected node is on, small in the editor's
 * top-right corner. Slides and the web page are the same pages (buildSlides)
 * with the same theme — paged one at a time, or stacked — so one preview shows
 * either, drawn by the shared page view (PageView.tsx) in the chosen variant.
 * Each format has its own action: ▶ starts the slideshow, 公開 publishes the
 * web page (`/w/:id`).
 * Follows the selection and every edit live. It never takes the keyboard.
 * Its left and bottom edges drag to resize it, keeping the page's 16:9.
 */
export default function PagePreview({ doc, activeNodeId, format, onFormatChange, onPresent, publish, onOpenTheme, onSlideSplit, onExit }: Props) {
  useLocale();
  const [open, setOpen] = useState(true);
  const [publishOpen, setPublishOpen] = useState(false);
  // The branch whose pages the split overview shows, for a few seconds after its choice changes.
  // A fresh object per choice, so choosing again restarts the timer.
  const [overview, setOverview] = useState<{ nodeId: string } | null>(null);
  useEffect(() => {
    if (!overview) return;
    const timer = setTimeout(() => setOverview(null), OVERVIEW_MS);
    return () => clearTimeout(timer);
  }, [overview]);
  const [scale, setScale] = useState(DEFAULT_PREVIEW_SCALE);
  // The size the background's drawing buffer is made for: it is rebuilt only when a drag ends, not on every move.
  const [settledScale, setSettledScale] = useState(DEFAULT_PREVIEW_SCALE);
  const drag = useRef<{ edge: PreviewResizeEdge; x: number; y: number; scale: number; latest: number } | null>(null);
  const settle = (next: number) => {
    setScale(next);
    setSettledScale(next);
  };
  // After mount, so the server render and hydration agree on the default size.
  useEffect(() => settle(loadPreviewScale(window.innerWidth)), []);

  const startResize = (edge: PreviewResizeEdge) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { edge, x: e.clientX, y: e.clientY, scale, latest: scale };
  };
  const moveResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.latest = resizedPreviewScale(d.edge, d.scale, e.clientX - d.x, e.clientY - d.y, window.innerWidth);
    setScale(d.latest);
  };
  const endResize = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    settle(d.latest);
    savePreviewScale(d.latest);
  };
  const resetSize = () => {
    settle(DEFAULT_PREVIEW_SCALE);
    savePreviewScale(DEFAULT_PREVIEW_SCALE);
  };
  const handle = (edge: PreviewResizeEdge, className: string) => (
    <div
      aria-hidden
      data-testid={`page-preview-resize-${edge}`}
      title={t("pagePreviewResize")}
      className={`absolute z-10 touch-none ${className}`}
      onPointerDown={startResize(edge)}
      onPointerMove={moveResize}
      onPointerUp={endResize}
      onPointerCancel={endResize}
      onDoubleClick={resetSize}
    />
  );
  const slides = useMemo(() => buildSlides(doc), [doc]);
  const index = useMemo(() => slideIndexOf(slides, doc, activeNodeId), [slides, doc, activeNodeId]);
  const slide = slides[index];
  // Resizing restyles the frame only; the page inside need not re-render on every move.
  const section = useMemo(() => slide && <PageSection slide={slide} index={index} />, [slide, index]);
  const width = VIRTUAL_WIDTH * scale;
  const height = VIRTUAL_HEIGHT * scale;
  const theme = effectiveTheme(doc.theme);
  // How many pages the selected branch takes, and the choice of how to split it.
  const active = activeNodeId ? findNode(doc, activeNodeId) : null;
  const branchPages = useMemo(
    () => (active && splittable(active) ? branchSlideIndices(slides, doc, active.id) : []),
    [slides, doc, active]
  );
  const branch = branchPages.length;
  // Only while that branch is still the selected one.
  const overviewPages = overview && overview.nodeId === active?.id ? branchPages : [];
  const button = "rounded-md px-1.5 py-0.5 text-[11px] text-slate-600 hover:bg-slate-100";
  const primary =
    "flex items-center gap-1 rounded-md bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50";

  return (
    <div
      data-testid="page-preview"
      className="pointer-events-auto relative rounded-xl bg-white/95 p-1.5 shadow-lg ring-1 ring-slate-200 backdrop-blur"
      style={{ width: width + 12 }}
    >
      {open && (
        <>
          {handle("left", "-left-1 top-0 bottom-2 w-2 cursor-ew-resize")}
          {handle("bottom", "-bottom-1 left-2 right-0 h-2 cursor-ns-resize")}
          {handle("corner", "-bottom-1 -left-1 h-3 w-3 cursor-nesw-resize")}
        </>
      )}
      <div className="flex items-center gap-1 px-0.5 pb-1">
        <Segmented
          label={t("pageFormat")}
          testId="page-format"
          className="mr-auto"
          choices={FORMATS}
          value={format}
          onChange={(f) => {
            onFormatChange(f);
            setPublishOpen(false);
          }}
        />
        <button
          type="button"
          className={button}
          aria-expanded={open}
          title={open ? t("pageHidePreview") : t("pageShowPreview")}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "▴" : "▾"}
        </button>
        <button type="button" className={button} title={t("pageModeExit")} aria-label={t("pageModeExit")} onClick={onExit}>
          ✕
        </button>
      </div>
      {open && (
        <div
          role="img"
          aria-label={t("pagePreview")}
          className="wp-frame rounded-md ring-1 ring-slate-200"
          style={{ width, height }}
        >
          <PageThemeAssets theme={theme} />
          <PageRoot
            theme={theme}
            variant={format}
            testId="page-preview-page"
            style={{
              width: VIRTUAL_WIDTH,
              height: VIRTUAL_HEIGHT,
              minHeight: 0,
              overflow: "hidden",
              transform: `scale(${scale})`,
              transformOrigin: "0 0",
              ["--wp-page-h" as string]: `${VIRTUAL_HEIGHT}px`,
            }}
          >
            {/* On the web page, the background is where it would be with this page on screen.
                It reads `resolution` once, so a settled resize restarts it at the new size. */}
            <PageBackground
              key={settledScale}
              background={theme.background}
              scrollY={format === "web" ? () => index * VIRTUAL_HEIGHT : undefined}
              scrollKey={format === "web" ? index : undefined}
              resolution={settledScale * 2}
            />
            {section}
          </PageRoot>
          {overviewPages.length > 0 && (
            <SplitOverview
              slides={slides}
              indices={overviewPages}
              theme={theme}
              width={width}
              height={height}
              onDismiss={() => setOverview(null)}
            />
          )}
        </div>
      )}
      <div className="flex items-center gap-1 px-0.5 pt-1">
        <span data-testid="page-preview-counter" className="mr-auto text-[11px] tabular-nums text-slate-500">
          {slides.length ? t("pagePageOf", { n: String(index + 1), total: String(slides.length) }) : t("presentEmpty")}
        </span>
        {onOpenTheme && (
          <button type="button" data-testid="page-theme-open" className={button} onClick={onOpenTheme}>
            {t("pageTheme")}
          </button>
        )}
        {format === "slide" ? (
          <button
            type="button"
            data-testid="page-present"
            title={t("presentStartHint")}
            onClick={onPresent}
            disabled={!slides.length}
            className={primary}
          >
            <PlayIcon width="9" height="9" />
            {t("presentStart")}
          </button>
        ) : (
          publish && (
            <button
              type="button"
              data-testid="page-publish-open"
              aria-expanded={publishOpen}
              onClick={() => setPublishOpen((v) => !v)}
              className={primary}
            >
              {t("webPublish")} {publishOpen ? "▴" : "▾"}
            </button>
          )
        )}
      </div>
      {active && branch > 0 && (
        <div className="flex items-center gap-1 px-0.5 pt-1">
          <span data-testid="page-branch-count" className="mr-auto truncate text-[11px] tabular-nums text-slate-500">
            {t("pageBranchCount", { n: String(branch) })}
          </span>
          {onSlideSplit && (
            <Segmented
              label={t("pageSlideSplit")}
              testId="page-split"
              choices={SPLITS}
              value={active.slideSplit ?? null}
              onChange={(split) => {
                onSlideSplit(active.id, split);
                setOverview({ nodeId: active.id });
              }}
            />
          )}
        </div>
      )}
      {format === "web" && publish && publishOpen && <PagePublish noteId={publish.noteId} isPublic={publish.isPublic} />}
    </div>
  );
}
