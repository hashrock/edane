import { useMemo, useState } from "react";
import { findNode, type MindMapDocument } from "../domain/model";
import { effectiveTheme } from "../domain/pageTheme";
import { branchSlideCount, buildSlides, slideIndexOf, splittable } from "../application/slides";
import { t } from "../application/i18n";
import type { MessageKey } from "../application/messages";
import { useLocale } from "./useLocale";
import { PlayIcon } from "./icons";
import PagePublish from "./PagePublish";
import { PageBackground, PageRoot, PageSection, PageThemeAssets, type PageVariant } from "./PageView";

/** The page is laid out at this size and scaled down, so it looks like the real page. */
const VIRTUAL_WIDTH = 1280;
const VIRTUAL_HEIGHT = 720;
const SCALE = 0.25;

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
 */
export default function PagePreview({ doc, activeNodeId, format, onFormatChange, onPresent, publish, onOpenTheme, onSlideSplit, onExit }: Props) {
  useLocale();
  const [open, setOpen] = useState(true);
  const [publishOpen, setPublishOpen] = useState(false);
  const slides = useMemo(() => buildSlides(doc), [doc]);
  const index = slideIndexOf(slides, doc, activeNodeId);
  const slide = slides[index];
  const theme = effectiveTheme(doc.theme);
  // How many pages the selected branch takes, and the choice of how to split it.
  const active = activeNodeId ? findNode(doc, activeNodeId) : null;
  const branch = active && splittable(active) ? branchSlideCount(slides, doc, active.id) : 0;
  const button = "rounded-md px-1.5 py-0.5 text-[11px] text-slate-600 hover:bg-slate-100";
  const primary =
    "flex items-center gap-1 rounded-md bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50";

  return (
    <div
      data-testid="page-preview"
      className="pointer-events-auto rounded-xl bg-white/95 p-1.5 shadow-lg ring-1 ring-slate-200 backdrop-blur"
      style={{ width: VIRTUAL_WIDTH * SCALE + 12 }}
    >
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
          style={{ width: VIRTUAL_WIDTH * SCALE, height: VIRTUAL_HEIGHT * SCALE }}
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
              transform: `scale(${SCALE})`,
              transformOrigin: "0 0",
              ["--wp-page-h" as string]: `${VIRTUAL_HEIGHT}px`,
            }}
          >
            {/* On the web page, the background is where it would be with this page on screen. */}
            <PageBackground
              background={theme.background}
              scrollY={format === "web" ? () => index * VIRTUAL_HEIGHT : undefined}
              scrollKey={format === "web" ? index : undefined}
              resolution={SCALE * 2}
            />
            {slide && <PageSection slide={slide} index={index} />}
          </PageRoot>
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
              onChange={(split) => onSlideSplit(active.id, split)}
            />
          )}
        </div>
      )}
      {format === "web" && publish && publishOpen && <PagePublish noteId={publish.noteId} isPublic={publish.isPublic} />}
    </div>
  );
}
