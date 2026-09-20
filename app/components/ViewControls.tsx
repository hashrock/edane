import { memo } from "react";
import { t } from "../application/i18n";
import { useLocale } from "./useLocale";
import type { EditorLayout } from "../application/editSurface";
import { useAnchoredPopover } from "./useAnchoredPopover";
import { MindmapIcon, OutlineIcon } from "./icons";
import type { MessageKey } from "../application/messages";

/** Zoom section of the pill. Omit it entirely on layouts without zoom. */
export interface ZoomControls {
  /** Current zoom as a whole percentage (100 = 1:1). */
  percent: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  /** Reset to 100% and bring the selected node back on screen (clicking the percentage). */
  onReset: () => void;
  /** Fit the whole document into the viewport (全体表示). */
  onFit: () => void;
}

interface Props {
  layout: EditorLayout;
  /**
   * Called with the layout the user picked. When absent the layout switch is
   * hidden and only the zoom controls render (standalone canvas editor).
   */
  onLayoutChange?: (layout: EditorLayout) => void;
  /**
   * Zoom controls. When absent WITH a layout switch present (the outline
   * layout), the zoom slot is still laid out — greyed and inert — so the pill
   * keeps the same width and the layout trigger sits at the same spot in both
   * layouts (usertest #5: a click aimed at "Mindmap ▾" from the other layout
   * must not land on a different control).
   */
  zoom?: ZoomControls;
}

// label はカタログキー（描画時に t() で解決 — 言語切り替えに追従する）。
const LAYOUTS: {
  value: EditorLayout;
  label: MessageKey;
  icon: React.ReactNode;
}[] = [
  { value: "canvas", label: "layoutMindmap", icon: <MindmapIcon width="15" height="15" /> },
  { value: "outline", label: "layoutOutline", icon: <OutlineIcon width="15" height="15" /> },
];

/**
 * Header view controls: a Mindmap / Outline layout dropdown and (on the
 * canvas) zoom out / percentage / zoom in / fit-all, grouped in one bordered
 * pill. The layout menu opens downward, below the pill (see
 * {@link useAnchoredPopover}).
 *
 * Memoized because the canvas re-renders on every wheel/pan tick — with stable
 * props this skips the whole pill on gestures that don't change the zoom.
 */
export default memo(function ViewControls({ layout, onLayoutChange, zoom }: Props) {
  useLocale(); // 言語切り替えで再レンダー（t() の購読; memo越しでも自前で購読する）
  const menu = useAnchoredPopover("down");
  const current = LAYOUTS.find((l) => l.value === layout) ?? LAYOUTS[0];
  // The outline layout has no zoom: keep the slot so the pill's geometry —
  // and therefore where the layout trigger sits — matches the canvas.
  const zoomPlaceholder = !zoom && !!onLayoutChange;
  const zoomDisabledTitle = zoomPlaceholder ? t("zoomUnavailableOutline") : undefined;
  const zoomButton =
    "flex h-6 w-6 items-center justify-center rounded-lg text-sm text-slate-500 hover:bg-slate-100 disabled:text-slate-300 disabled:hover:bg-transparent";

  return (
    <div
      data-testid="view-controls"
      className="flex shrink-0 items-center gap-0.5 rounded-xl bg-white p-1"
    >
      {onLayoutChange && (
        <>
          <button
            type="button"
            ref={menu.triggerRef}
            popoverTarget={menu.popId}
            data-testid="view-layout-trigger"
            style={menu.triggerStyle}
            className="flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
          >
            <span className="text-slate-500">{current.icon}</span>
            {t(current.label)}
            <span
              className={`text-xs text-slate-500 transition-transform ${
                menu.open ? "rotate-180" : ""
              }`}
            >
              ▾
            </span>
          </button>
          <div
            ref={menu.popoverRef}
            id={menu.popId}
            popover="auto"
            onToggle={menu.handleToggle}
            style={menu.popoverStyle}
            className="min-w-[140px] overflow-hidden rounded-lg border border-slate-200 bg-white p-1 shadow-xl"
          >
            {LAYOUTS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                data-testid={`view-layout-${opt.value}`}
                onClick={() => {
                  menu.popoverRef.current?.hidePopover();
                  if (opt.value !== layout) onLayoutChange(opt.value);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100"
              >
                <span className="text-slate-500">{opt.icon}</span>
                <span className="flex-1">{t(opt.label)}</span>
                {opt.value === layout && <span className="text-slate-900">✓</span>}
              </button>
            ))}
          </div>
        </>
      )}
      {/* The inert placeholder only matters where both layouts are a click
          apart (wide screens); on a phone the outline is the default and the
          header has no room for a dead zoom slot. */}
      {(zoom || zoomPlaceholder) && (
        <div
          className={`flex items-center gap-0.5 ${zoomPlaceholder ? "hidden md:flex" : ""}`}
        >
          {onLayoutChange && <div className="mx-0.5 h-4 w-px bg-slate-200" />}
          <button
            type="button"
            aria-label={t("zoomOut")}
            title={zoomDisabledTitle ?? t("zoomOut")}
            disabled={!zoom}
            onClick={zoom?.onZoomOut}
            className={zoomButton}
          >
            −
          </button>
          <button
            type="button"
            data-testid="view-zoom-percent"
            title={zoomDisabledTitle ?? t("zoomReset")}
            disabled={!zoom}
            onClick={zoom?.onReset}
            className="w-10 rounded-lg px-1 py-1 text-center text-xs tabular-nums text-slate-600 hover:bg-slate-100 disabled:text-slate-300 disabled:hover:bg-transparent"
          >
            {zoom ? `${zoom.percent}%` : "—"}
          </button>
          <button
            type="button"
            aria-label={t("zoomIn")}
            title={zoomDisabledTitle ?? t("zoomIn")}
            disabled={!zoom}
            onClick={zoom?.onZoomIn}
            className={zoomButton}
          >
            +
          </button>
          <button
            type="button"
            data-testid="view-zoom-fit"
            aria-label={t("zoomFit")}
            title={zoomDisabledTitle ?? t("zoomFit")}
            disabled={!zoom}
            onClick={zoom?.onFit}
            className="flex h-6 items-center gap-1 whitespace-nowrap rounded-lg px-1.5 text-xs text-slate-600 hover:bg-slate-100 disabled:text-slate-300 disabled:hover:bg-transparent"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
            </svg>
            <span className="hidden md:inline">{t("zoomFit")}</span>
          </button>
        </div>
      )}
    </div>
  );
});
