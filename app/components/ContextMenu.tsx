import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface ContextMenuAction {
  label: string;
  onSelect: () => void;
  /** Render in a destructive (red) style. */
  danger?: boolean;
  /** Optional leading icon. */
  icon?: React.ReactNode;
  /**
   * 押せない状態。項目を消すのではなく残したまま無効化するので、なぜ押せないかを
   * {@link disabledReason} で必ず添えること。
   */
  disabled?: boolean;
  /** 無効な理由。ラベルの下に小さく出る。 */
  disabledReason?: string;
}

/** A horizontal divider between categories. */
export interface ContextMenuSeparator {
  separator: true;
}

export type ContextMenuItem = ContextMenuAction | ContextMenuSeparator;

function isSeparator(item: ContextMenuItem): item is ContextMenuSeparator {
  return "separator" in item;
}

interface Props {
  /** Viewport (clientX/clientY) coordinates of the click. */
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export default function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // Close on outside click, Escape, scroll, or resize.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("wheel", onClose, { passive: true });
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("wheel", onClose);
    };
  }, [onClose]);

  // Keep the menu inside the viewport.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let nx = x;
    let ny = y;
    if (x + rect.width > window.innerWidth) nx = window.innerWidth - rect.width - 8;
    if (y + rect.height > window.innerHeight)
      ny = window.innerHeight - rect.height - 8;
    setPos({ x: Math.max(8, nx), y: Math.max(8, ny) });
  }, [x, y]);

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[180px] overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-xl"
      style={{ left: pos.x, top: pos.y }}
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
          </button>
        )
      )}
    </div>
  );
}
