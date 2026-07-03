import { useEffect } from "react";
import type { KeyBinding } from "../application/editorKeymap";

interface Props {
  bindings: KeyBinding[];
  open: boolean;
  onClose: () => void;
}

const GROUPS: { when: KeyBinding["when"]; title: string }[] = [
  { when: "global", title: "共通" },
  { when: "both", title: "ノード操作" },
  { when: "selection", title: "ノード選択中" },
  { when: "editing", title: "テキスト編集中" },
];

/**
 * Keyboard-shortcut cheat sheet, generated from the same keymap the editor
 * runs. Bindings with an empty label (redundant aliases, standard text-editing
 * keys) are hidden.
 */
export default function ShortcutHelp({ bindings, open, onClose }: Props) {
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
          <h2 className="text-sm font-bold text-slate-800">
            キーボードショートカット
          </h2>
          <button
            onClick={onClose}
            className="rounded px-2 py-1 text-sm text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label="閉じる"
          >
            ✕
          </button>
        </div>
        <div className="px-5 py-3">
          {GROUPS.map((group) => {
            const rows = bindings.filter(
              (b) => b.when === group.when && b.label !== ""
            );
            if (rows.length === 0) return null;
            return (
              <div key={group.when} className="mb-4 last:mb-1">
                <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  {group.title}
                </h3>
                <ul>
                  {rows.map((b) => (
                    <li
                      key={b.id}
                      className="flex items-center justify-between gap-4 py-1 text-sm"
                    >
                      <span className="text-slate-700">{b.label}</span>
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
