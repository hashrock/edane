import { useEffect } from "react";
import type { KeyBinding } from "../application/editorKeymap";
import { t } from "../application/i18n";
import type { MessageKey } from "../application/messages";
import { useLocale } from "./useLocale";

interface Props {
  bindings: KeyBinding[];
  open: boolean;
  onClose: () => void;
}

/**
 * Display title per `when` scope, in the order the overlay groups them.
 * `satisfies Record<KeyBinding["when"], MessageKey>` makes this exhaustive
 * both ways (same idiom as STORED_NODE_TYPE_SET in domain/model.ts): a plain
 * array here would let a new `when` scope on KeyBinding compile silently and
 * just vanish from the help overlay instead of erroring loudly at the type
 * level. `Object.keys` preserves the string-key insertion order below, so the
 * display order is still just the order written here.
 */
const GROUP_TITLES = {
  global: "helpGroupGlobal",
  both: "helpGroupNode",
  selection: "helpGroupSelection",
  editing: "helpGroupEditing",
} as const satisfies Record<KeyBinding["when"], MessageKey>;

const GROUP_ORDER = Object.keys(GROUP_TITLES) as (keyof typeof GROUP_TITLES)[];

/**
 * Keyboard-shortcut cheat sheet, generated from the same keymap the editor
 * runs. Bindings with an empty label (redundant aliases, standard text-editing
 * keys) are hidden.
 */
export default function ShortcutHelp({ bindings, open, onClose }: Props) {
  useLocale(); // 言語切り替えで再レンダー（t() の購読）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 pt-[10vh]"
      onClick={onClose}
    >
      <div
        className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-lg border bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-5 py-3">
          <h2 className="text-sm font-bold text-slate-800">{t("helpTitle")}</h2>
          <button
            onClick={onClose}
            className="rounded px-2 py-1 text-sm text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label={t("close")}
          >
            ✕
          </button>
        </div>
        <div className="px-5 py-3">
          {GROUP_ORDER.map((when) => {
            const rows = bindings.filter(
              (b) => b.when === when && b.label !== ""
            );
            if (rows.length === 0) return null;
            return (
              <div key={when} className="mb-4 last:mb-1">
                <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  {t(GROUP_TITLES[when])}
                </h3>
                <ul>
                  {rows.map((b) => (
                    <li
                      key={b.id}
                      className="flex items-center justify-between gap-4 py-1 text-sm"
                    >
                      <span className="text-slate-700">
                        {b.label === "" ? "" : t(b.label)}
                      </span>
                      <kbd className="whitespace-nowrap rounded border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-xs text-slate-600">
                        {b.keys}
                      </kbd>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
