import { useEffect, useLayoutEffect, useRef, useState } from "react";

type ContextMenuActionBase = {
  label: string;
  onSelect: () => void;
  /** Render in a destructive (red) style. */
  danger?: boolean;
  /** Optional leading icon. */
  icon?: React.ReactNode;
  /**
   * Key hint shown at the right edge ("⌘ ."). Callers derive it from the live
   * keymap (application/menuShortcuts.ts) so it only names keys that fire.
   */
  shortcut?: string;
};

/**
 * 押せない状態にするなら、項目を消すのではなく残したまま無効化し、なぜ押せないかを
 * disabledReason で必ず添える。型でこの対を強制する（disabled だけ立てて
 * disabledReason を書き忘れる、を作れないようにする）。
 */
export type ContextMenuAction = ContextMenuActionBase &
  (
    | { disabled?: undefined; disabledReason?: undefined }
    | { disabled: boolean; disabledReason: string }
  );

/** A horizontal divider between categories. */
export interface ContextMenuSeparator {
  separator: true;
}

export type ContextMenuItem = ContextMenuAction | ContextMenuSeparator;

function isSeparator(item: ContextMenuItem): item is ContextMenuSeparator {
  return "separator" in item;
}

interface Props {
  /** Viewport (clientX/clientY) coordinates of the click (or right edge when align="right"). */
  x: number;
  y: number;
  /** Align the menu's left edge (default) or right edge to `x`. */
  align?: "left" | "right";
  items: ContextMenuItem[];
  onClose: () => void;
}

export default function ContextMenu({ x, y, align = "left", items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  // Close on outside click, Escape, scroll, or resize.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    // Touch: a tap outside may not produce a compat mousedown (the canvas
    // cancels its touch events), so listen for the pointer too.
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("wheel", onClose, { passive: true });
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("wheel", onClose);
    };
  }, [onClose]);

  // Measure at left: 0 (unconstrained by the right edge), then place inside the viewport.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let nx = align === "right" ? x - rect.width : x;
    let ny = y;
    if (nx + rect.width > window.innerWidth) nx = window.innerWidth - rect.width - 8;
    if (ny + rect.height > window.innerHeight)
      ny = window.innerHeight - rect.height - 8;
    setPos({ x: Math.max(8, nx), y: Math.max(8, ny) });
  }, [x, y, align]);

  return (
    <div
      ref={ref}
      className="fixed z-50 max-h-[calc(100vh-16px)] min-w-[180px] max-w-[calc(100vw-16px)] overflow-y-auto overscroll-contain rounded-lg border border-slate-200 bg-white py-1 shadow-xl"
      style={
        pos
          ? { left: pos.x, top: pos.y }
          : { left: 0, top: 0, visibility: "hidden" }
      }
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        isSeparator(item) ? (
          <div key={i} className="my-1 border-t border-slate-200" role="separator" />
        ) : (
          <button
            key={i}
            type="button"
            disabled={item.disabled}
            className={`flex w-full items-start gap-2.5 px-3 py-2 text-left text-sm hover:bg-slate-100 disabled:cursor-not-allowed disabled:text-slate-400 disabled:hover:bg-transparent ${
              item.danger ? "text-red-600" : "text-slate-700"
            }`}
            onClick={() => {
              item.onSelect();
              onClose();
            }}
          >
            {item.icon && (
              <span className="flex w-4 shrink-0 justify-center pt-0.5">
                {item.icon}
              </span>
            )}
            <span className="flex-1">
              {item.label}
              {item.disabled && item.disabledReason && (
                <span className="mt-0.5 block text-xs text-slate-400">
                  {item.disabledReason}
                </span>
              )}
            </span>
            {item.shortcut && (
              <kbd
                data-testid="menu-shortcut"
                className="shrink-0 whitespace-nowrap pt-0.5 pl-4 font-sans text-xs text-slate-400"
              >
                {item.shortcut}
              </kbd>
            )}
          </button>
        )
      )}
    </div>
  );
}
