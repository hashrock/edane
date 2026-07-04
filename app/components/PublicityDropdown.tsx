import { useEffect, useRef, useState } from "react";

interface Props {
  isPublic: boolean;
  /** Called with the newly chosen publicity when the user picks an option. */
  onChange: (next: boolean) => void;
}

const OPTIONS: { value: boolean; label: string }[] = [
  { value: false, label: "自分だけ" },
  { value: true, label: "みんなに公開" },
];

/**
 * Publicity selector rendered as a dropdown (replaces the old "公開する"
 * checkbox). The trigger shows the current state; the menu lists both options
 * with a check next to the active one. Closes on outside click or Escape.
 */
export default function PublicityDropdown({ isPublic, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 whitespace-nowrap rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
      >
        {isPublic ? "みんなに公開中" : "自分だけ"}
        <span
          className={`text-[10px] text-slate-400 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        >
          ▾
        </span>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 min-w-[160px] overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-xl">
          {OPTIONS.map((opt) => (
            <button
              key={String(opt.value)}
              type="button"
              onClick={() => {
                setOpen(false);
                if (opt.value !== isPublic) onChange(opt.value);
              }}
              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100"
            >
              {opt.label}
              {opt.value === isPublic && (
                <span className="text-slate-900">✓</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
