import { useEffect } from "react";
import type { EditorPreferences } from "../application/editorPreferences";

interface Props {
  open: boolean;
  prefs: EditorPreferences;
  onChange: (prefs: EditorPreferences) => void;
  onClose: () => void;
}

/**
 * Keyboard-preference settings (persisted per device in localStorage — see
 * editorPreferences.ts). The two radio groups only apply while selection mode
 * is on, so they grey out when the parent toggle turns it off, and a note
 * lists the chorded replacements that take over in always-edit mode.
 */
export default function EditorSettingsDialog({
  open,
  prefs,
  onChange,
  onClose,
}: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const radio = (
    name: string,
    checked: boolean,
    disabled: boolean,
    label: string,
    description: string,
    onSelect: () => void
  ) => (
    <label
      className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 ${
        checked ? "border-emerald-500 bg-emerald-50/50" : "border-slate-200"
      } ${disabled ? "cursor-not-allowed opacity-40" : "hover:bg-slate-50"}`}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
        className="mt-0.5 accent-emerald-600"
      />
      <span>
        <span className="block text-sm font-medium text-slate-800">
          {label}
        </span>
        <span className="block text-xs leading-relaxed text-slate-500">
          {description}
        </span>
      </span>
    </label>
  );

  return (
    <div
      className="anim-overlay fixed inset-0 z-50 flex items-start justify-center bg-black/20 px-4 pt-[10vh]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="エディタ設定"
    >
      <div
        className="anim-modal max-h-[80vh] w-full max-w-md overflow-y-auto rounded-lg border bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-5 py-3">
          <h2 className="text-sm font-bold text-slate-800">エディタ設定</h2>
          <button
            onClick={onClose}
            className="rounded px-2 py-1 text-sm text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label="閉じる"
          >
            ✕
          </button>
        </div>
        <div className="space-y-5 px-5 py-4">
          <section>
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={prefs.selectionMode}
                onChange={(e) =>
                  onChange({ ...prefs, selectionMode: e.target.checked })
                }
                className="mt-0.5 accent-emerald-600"
              />
              <span>
                <span className="block text-sm font-medium text-slate-800">
                  選択モードを使う
                </span>
                <span className="block text-xs leading-relaxed text-slate-500">
                  オフにすると常に編集モードになり、クリックした位置にカーソルが入ります。
                </span>
              </span>
            </label>
            {!prefs.selectionMode && (
              <div className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
                常時編集モードの操作: 枝ごと削除は{" "}
                <kbd className="rounded border border-slate-200 bg-white px-1 font-mono">
                  ⌘/Ctrl + Shift + Backspace
                </kbd>
                、枝の開閉は{" "}
                <kbd className="rounded border border-slate-200 bg-white px-1 font-mono">
                  ⌘/Ctrl + .
                </kbd>
                、ショートカット一覧は{" "}
                <kbd className="rounded border border-slate-200 bg-white px-1 font-mono">
                  ⌘/Ctrl + /
                </kbd>
              </div>
            )}
          </section>
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
              選択中の Tab キー
            </h3>
            <div className="space-y-1.5">
              {radio(
                "tabBehavior",
                prefs.tabBehavior === "indent",
                !prefs.selectionMode,
                "インデント",
                "選択ノードを直前のノードの子にする（Shift + Tab で戻す）",
                () => onChange({ ...prefs, tabBehavior: "indent" })
              )}
              {radio(
                "tabBehavior",
                prefs.tabBehavior === "insert-child",
                !prefs.selectionMode,
                "子ノードを挿入",
                "選択ノードの下に新しい子を作って編集を始める（Shift + Tab はアウトデント）",
                () => onChange({ ...prefs, tabBehavior: "insert-child" })
              )}
            </div>
          </section>
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
              選択中の ← / → キー
            </h3>
            <div className="space-y-1.5">
              {radio(
                "arrowBehavior",
                prefs.arrowBehavior === "collapse",
                !prefs.selectionMode,
                "枝の開閉を優先",
                "→ で展開、← で折りたたみ。開閉できないときは親子へ移動",
                () => onChange({ ...prefs, arrowBehavior: "collapse" })
              )}
              {radio(
                "arrowBehavior",
                prefs.arrowBehavior === "navigate",
                !prefs.selectionMode,
                "親子への移動を優先",
                "→ で子ノードへ、← で親ノードへ。開閉は ⌘/Ctrl + .",
                () => onChange({ ...prefs, arrowBehavior: "navigate" })
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
