import { useId, useRef, useState } from "react";

// CSS anchor positioning is Chromium-only today; elsewhere the popover would
// render top-layer but unanchored (centered). Detect support once so we can
// fall back to positioning it from the trigger's rect by hand.
const SUPPORTS_ANCHOR =
  typeof CSS !== "undefined" && CSS.supports?.("anchor-name: --a");

/**
 * Shared machinery for a dropdown menu rendered with the Popover API
 * (`popover="auto"`): the menu lives in the browser top layer — it can never be
 * hidden behind the Konva canvas or any other stacking context — and
 * light-dismiss (outside click / Escape) is handled by the platform.
 *
 * The menu is pinned to the trigger's right edge, opening below (`side:
 * "down"`) or above (`side: "up"`). CSS anchor positioning does the pinning
 * where supported; otherwise {@link handleToggle} positions the popover from
 * the trigger's rect by hand on each open.
 *
 * Wiring: spread `triggerStyle` on the trigger button (with `popoverTarget:
 * popId` and `ref: triggerRef`) and `popoverStyle` on the popover div (with
 * `id: popId`, `popover="auto"`, `ref: popoverRef`, `onToggle: handleToggle`).
 */
export function useAnchoredPopover(side: "up" | "down") {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Unique, CSS-ident-safe names so multiple instances don't clash.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const popId = `anchored-popover-${uid}`;
  const anchorName = `--anchored-popover-${uid}`;

  const handleToggle = (e: React.ToggleEvent<HTMLDivElement>) => {
    const nowOpen = e.newState === "open";
    setOpen(nowOpen);
    if (nowOpen && !SUPPORTS_ANCHOR) {
      const t = triggerRef.current;
      const p = popoverRef.current;
      if (t && p) {
        const r = t.getBoundingClientRect();
        if (side === "down") {
          p.style.top = `${r.bottom + 4}px`;
          p.style.bottom = "auto";
        } else {
          p.style.bottom = `${window.innerHeight - r.top + 4}px`;
          p.style.top = "auto";
        }
        p.style.right = `${window.innerWidth - r.right}px`;
        p.style.left = "auto";
        p.style.margin = "0";
      }
    }
  };

  const triggerStyle = { anchorName } as React.CSSProperties;
  const popoverStyle = {
    positionAnchor: anchorName,
    right: "anchor(right)",
    left: "auto",
    // `margin` must precede the longhand below — React applies style keys in
    // object order, and the shorthand would reset the directional margin.
    margin: 0,
    ...(side === "down"
      ? { top: "anchor(bottom)", bottom: "auto", marginTop: "4px" }
      : { bottom: "anchor(top)", top: "auto", marginBottom: "4px" }),
  } as React.CSSProperties;

  return {
    open,
    popId,
    triggerRef,
    popoverRef,
    handleToggle,
    triggerStyle,
    popoverStyle,
  };
}
