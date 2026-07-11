import { useAnchoredPopover } from "./useAnchoredPopover";
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
 * with a check next to the active one. The top-layer popover + anchor
 * positioning mechanics live in {@link useAnchoredPopover}.
 */
export default function PublicityDropdown({ isPublic, onChange }: Props) {
  const menu = useAnchoredPopover("down");

  return (
    <>
      <button
        type="button"
        ref={menu.triggerRef}
        popoverTarget={menu.popId}
        style={menu.triggerStyle}
        className="flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
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
        {OPTIONS.map((opt) => (
          <button
            key={String(opt.value)}
            type="button"
            onClick={() => {
              menu.popoverRef.current?.hidePopover();
              if (opt.value !== isPublic) onChange(opt.value);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100"
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
