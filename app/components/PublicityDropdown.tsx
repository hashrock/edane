import { useId, useRef, useState } from "react";
import { GlobeIcon, LockIcon } from "./icons";

interface Props {
  isPublic: boolean;
  /** Called with the newly chosen publicity when the user picks an option. */
  onChange: (next: boolean) => void;
}

const OPTIONS: { value: boolean; label: string; icon: React.ReactNode }[] = [
  { value: false, label: "非公開", icon: <LockIcon width="15" height="15" /> },
  { value: true, label: "公開", icon: <GlobeIcon width="15" height="15" /> },
];

/**
 * Publicity selector rendered as a dropdown (replaces the old "公開する"
 * checkbox). The trigger shows the current state; the menu lists both options
 * with a check next to the active one.
 *
 * The menu uses the Popover API (`popover="auto"`) so it renders in the browser
 * top layer — it can never be hidden behind the Konva canvas or any other
 * stacking context (the previous z-index approach lost that fight). CSS anchor
 * positioning pins it to the trigger's bottom-right. Light-dismiss (outside
 * click / Escape) is handled by the platform, so no manual listeners are needed.
 */
// CSS anchor positioning is Chromium-only today; elsewhere the popover would
// render top-layer but unanchored (centered). Detect support once so we can
// fall back to positioning it from the trigger's rect by hand.
const SUPPORTS_ANCHOR =
  typeof CSS !== "undefined" && CSS.supports?.("anchor-name: --a");

export default function PublicityDropdown({ isPublic, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Unique, CSS-ident-safe names so multiple instances don't clash.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const popId = `publicity-menu-${uid}`;
  const anchorName = `--publicity-anchor-${uid}`;

  const handleToggle = (e: React.ToggleEvent<HTMLDivElement>) => {
    const nowOpen = e.newState === "open";
    setOpen(nowOpen);
    // Fallback positioning for browsers without CSS anchor positioning: pin the
    // popover's top-right under the trigger using viewport coordinates.
    if (nowOpen && !SUPPORTS_ANCHOR) {
      const t = triggerRef.current;
      const p = popoverRef.current;
      if (t && p) {
        const r = t.getBoundingClientRect();
        p.style.top = `${r.bottom + 4}px`;
        p.style.right = `${window.innerWidth - r.right}px`;
        p.style.left = "auto";
        p.style.bottom = "auto";
        p.style.margin = "0";
      }
    }
  };

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        popoverTarget={popId}
        style={{ anchorName } as React.CSSProperties}
        className="flex items-center gap-1.5 whitespace-nowrap rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
      >
        <span className="text-slate-500">
          {isPublic ? (
            <GlobeIcon width="15" height="15" />
          ) : (
            <LockIcon width="15" height="15" />
          )}
        </span>
        {isPublic ? "公開" : "非公開"}
        <span
          className={`text-xs text-slate-500 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        >
          ▾
        </span>
      </button>
      <div
        ref={popoverRef}
        id={popId}
        popover="auto"
        onToggle={handleToggle}
        style={
          {
            positionAnchor: anchorName,
            top: "anchor(bottom)",
            right: "anchor(right)",
            left: "auto",
            bottom: "auto",
            margin: 0,
            marginTop: "4px",
          } as React.CSSProperties
        }
        className="min-w-[160px] overflow-hidden rounded-lg border border-slate-200 bg-white p-1 shadow-xl"
      >
        {OPTIONS.map((opt) => (
          <button
            key={String(opt.value)}
            type="button"
            onClick={() => {
              popoverRef.current?.hidePopover();
              if (opt.value !== isPublic) onChange(opt.value);
            }}
            className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100"
          >
            <span className="text-slate-500">{opt.icon}</span>
            <span className="flex-1">{opt.label}</span>
            {opt.value === isPublic && <span className="text-slate-900">✓</span>}
          </button>
        ))}
      </div>
    </>
  );
}
