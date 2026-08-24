import { useEffect } from "react";
import type { EditorPreferences } from "../application/editorPreferences";
import {
  LOCALE_LABELS,
  setLocale,
  t,
  type Locale,
} from "../application/i18n";
import { useLocale } from "./useLocale";

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
 * UI言語（application/i18n.ts）もここから切り替える — キーボード設定と同じ
 * 「このデバイスの表示設定」なので同じダイアログに置く。
 */
export default function EditorSettingsDialog({
  open,
  prefs,
  onChange,
  onClose,
}: Props) {
  const locale = useLocale();
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
      aria-label={t("editorSettings")}
    >
      <div
        className="anim-modal max-h-[80vh] w-full max-w-md overflow-y-auto rounded-lg border bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-5 py-3">
          <h2 className="text-sm font-bold text-slate-800">
            {t("editorSettings")}
          </h2>
          <button
            onClick={onClose}
            className="rounded px-2 py-1 text-sm text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label={t("close")}
          >
            ✕
          </button>
        </div>
        <div className="space-y-5 px-5 py-4">
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
              {t("languageHeading")}
            </h3>
            <div className="flex gap-1.5">
              {(Object.keys(LOCALE_LABELS) as Locale[]).map((l) => (
                <label
                  key={l}
                  className={`flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium ${
                    locale === l
                      ? "border-emerald-500 bg-emerald-50/50 text-slate-800"
                      : "border-slate-200 text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  <input
                    type="radio"
                    name="uiLocale"
                    checked={locale === l}
                    onChange={() => setLocale(l)}
                    className="accent-emerald-600"
                  />
                  {LOCALE_LABELS[l]}
                </label>
              ))}
            </div>
          </section>
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
                  {t("selectionModeLabel")}
                </span>
                <span className="block text-xs leading-relaxed text-slate-500">
                  {t("selectionModeDesc")}
                </span>
              </span>
            </label>
            {!prefs.selectionMode && (
              <div className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
                {t("alwaysEditHintPrefix")}{" "}
                <kbd className="rounded border border-slate-200 bg-white px-1 font-mono">
                  ⌘/Ctrl + Shift + Backspace
                </kbd>
                {t("alwaysEditHintCollapse")}{" "}
                <kbd className="rounded border border-slate-200 bg-white px-1 font-mono">
                  ⌘/Ctrl + .
                </kbd>
                {t("alwaysEditHintHelp")}{" "}
                <kbd className="rounded border border-slate-200 bg-white px-1 font-mono">
                  ⌘/Ctrl + /
                </kbd>
                {t("alwaysEditHintSuffix")}
              </div>
            )}
          </section>
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
              {t("tabKeyHeading")}
            </h3>
            <div className="space-y-1.5">
              {radio(
                "tabBehavior",
                prefs.tabBehavior === "indent",
                !prefs.selectionMode,
                t("kmIndent"),
                t("tabIndentDesc"),
                () => onChange({ ...prefs, tabBehavior: "indent" })
              )}
              {radio(
                "tabBehavior",
                prefs.tabBehavior === "insert-child",
                !prefs.selectionMode,
                t("kmInsertChild"),
                t("tabInsertChildDesc"),
                () => onChange({ ...prefs, tabBehavior: "insert-child" })
              )}
            </div>
          </section>
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
              {t("enterKeyHeading")}
            </h3>
            <div className="space-y-1.5">
              {radio(
                "enterBehavior",
                prefs.enterBehavior === "insert-sibling",
                !prefs.selectionMode,
                t("kmInsertSibling"),
                t("enterInsertSiblingDesc"),
                () => onChange({ ...prefs, enterBehavior: "insert-sibling" })
              )}
              {radio(
                "enterBehavior",
                prefs.enterBehavior === "edit",
                !prefs.selectionMode,
                t("kmStartEditing"),
                t("enterEditDesc"),
                () => onChange({ ...prefs, enterBehavior: "edit" })
              )}
            </div>
          </section>
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
              {t("arrowKeyHeading")}
            </h3>
            <div className="space-y-1.5">
              {radio(
                "arrowBehavior",
                prefs.arrowBehavior === "collapse",
                !prefs.selectionMode,
                t("arrowCollapseLabel"),
                t("arrowCollapseDesc"),
                () => onChange({ ...prefs, arrowBehavior: "collapse" })
              )}
              {radio(
                "arrowBehavior",
                prefs.arrowBehavior === "navigate",
                !prefs.selectionMode,
                t("arrowNavigateLabel"),
                t("arrowNavigateDesc"),
                () => onChange({ ...prefs, arrowBehavior: "navigate" })
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
