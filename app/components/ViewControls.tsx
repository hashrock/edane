import { memo } from "react";
import type { EditorLayout } from "../application/editSurface";
import { useAnchoredPopover } from "./useAnchoredPopover";
import { MindmapIcon, OutlineIcon } from "./icons";

/** Zoom section of the pill. Omit it entirely on layouts without zoom. */
export interface ZoomControls {
  /** Current zoom as a whole percentage (100 = 1:1). */
  percent: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  /** Reset to 100% (clicking the percentage). */
  onReset: () => void;
}

interface Props {
  layout: EditorLayout;
  /**
   * Called with the layout the user picked. When absent the layout switch is
   * hidden and only the zoom controls render (standalone canvas editor).
   */
  onLayoutChange?: (layout: EditorLayout) => void;
  zoom?: ZoomControls;
}

const LAYOUTS: {
  value: EditorLayout;
  label: string;
  icon: React.ReactNode;
}[] = [
  { value: "canvas", label: "Mindmap", icon: <MindmapIcon width="15" height="15" /> },
  { value: "outline", label: "Outline", icon: <OutlineIcon width="15" height="15" /> },
];

/**
 * Header view controls: a Mindmap / Outline layout dropdown and (on the
 * canvas) zoom out / percentage / zoom in, grouped in one bordered pill. The
 * layout menu opens downward, below the pill (see {@link useAnchoredPopover}).
 *
 * Memoized because the canvas re-renders on every wheel/pan tick — with stable
 * props this skips the whole pill on gestures that don't change the zoom.
 */
export default memo(function ViewControls({ layout, onLayoutChange, zoom }: Props) {
  const menu = useAnchoredPopover("down");
  const current = LAYOUTS.find((l) => l.value === layout) ?? LAYOUTS[0];

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
            {current.label}
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
                <span className="flex-1">{opt.label}</span>
                {opt.value === layout && <span className="text-slate-900">✓</span>}
              </button>
            ))}
          </div>
        </>
      )}
      {onLayoutChange && zoom && <div className="mx-0.5 h-4 w-px bg-slate-200" />}
      {zoom && (
        <>
          <button
            type="button"
            aria-label="ズームアウト"
            title="ズームアウト"
            onClick={zoom.onZoomOut}
            className="flex h-6 w-6 items-center justify-center rounded-lg text-sm text-slate-500 hover:bg-slate-100"
          >
            −
          </button>
          <button
            type="button"
            data-testid="view-zoom-percent"
            title="100%に戻す"
            onClick={zoom.onReset}
            className="w-10 rounded-lg px-1 py-1 text-center text-xs tabular-nums text-slate-600 hover:bg-slate-100"
          >
            {zoom.percent}%
          </button>
          <button
            type="button"
            aria-label="ズームイン"
            title="ズームイン"
            onClick={zoom.onZoomIn}
            className="flex h-6 w-6 items-center justify-center rounded-lg text-sm text-slate-500 hover:bg-slate-100"
          >
            +
          </button>
        </>
      )}
    </div>
  );
});
