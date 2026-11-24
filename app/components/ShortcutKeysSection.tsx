import { useEffect, useMemo, useState } from "react";
import { assignCustomKey, resetCustomKey } from "../application/customKeys";
import { buildKeymap } from "../application/editorKeymap";
import type { EditorPreferences } from "../application/editorPreferences";
import { t } from "../application/i18n";
import {
  CUSTOM_KEY_IDS,
  comboFromEvent,
  formatCombo,
  type ComboProblem,
  type CustomKeyId,
} from "../application/keyCombo";
import { detectKeyPlatform, platformKeys } from "../application/menuShortcuts";
import type { MessageKey } from "../application/messages";

const PROBLEM_TEXT = {
  "fixed-key": "shortcutErrFixedKey",
  "needs-modifier": "shortcutErrNeedsModifier",
  reserved: "shortcutErrReserved",
} as const satisfies Record<ComboProblem, MessageKey>;

const MODIFIERS = new Set(["Meta", "Control", "Shift", "Alt", "AltGraph", "OS"]);

interface Props {
  prefs: EditorPreferences;
  onChange: (prefs: EditorPreferences) => void;
}

/**
 * The settings dialog's key list: each assignable command with its current
 * key, a "Change" button that records the next key pressed, and a reset.
 * Keys come from the same keymap the editor runs, so the row shows exactly
 * what fires.
 */
export default function ShortcutKeysSection({ prefs, onChange }: Props) {
  const [recording, setRecording] = useState<CustomKeyId | null>(null);
  const [error, setError] = useState<{ id: CustomKeyId; text: string } | null>(null);
  const platform = useMemo(() => detectKeyPlatform(), []);
  const keymap = useMemo(() => buildKeymap(prefs, "canvas"), [prefs]);

  // While recording, the next key belongs to the recorder — not to the
  // dialog's Escape-to-close or the editor underneath — so listen in the
  // capture phase and stop it there.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      if (MODIFIERS.has(e.key)) return; // still holding modifiers
      const combo = comboFromEvent(e);
      const result = assignCustomKey(prefs, recording, combo);
      if (result.ok) {
        setError(null);
        setRecording(null);
        onChange(result.prefs);
        return;
      }
      const keys = platformKeys(formatCombo(combo), platform);
      setError({
        id: recording,
        text:
          result.problem === "conflict"
            ? t("shortcutErrConflict", {
                keys,
                name: result.conflict.label === "" ? result.conflict.keys : t(result.conflict.label),
              })
            : `${keys}: ${t(PROBLEM_TEXT[result.problem])}`,
      });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, prefs, onChange, platform]);

  const anyCustom = Object.keys(prefs.customKeys).length > 0;

  return (
    <section data-testid="shortcut-keys">
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
        {t("shortcutKeysHeading")}
      </h3>
      <p className="mb-2 text-xs leading-relaxed text-slate-500">{t("shortcutKeysDesc")}</p>
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
        {CUSTOM_KEY_IDS.map((id) => {
          const b = keymap.find((x) => x.id === id);
          if (!b) return null;
          const isRecording = recording === id;
          return (
            <li key={id} data-key-id={id} className="px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="flex-1 text-sm text-slate-700">
                  {b.label === "" ? id : t(b.label)}
                </span>
                {isRecording ? (
                  <span className="text-xs text-emerald-700" role="status">
                    {t("shortcutRecording")}
                  </span>
                ) : (
                  <kbd className="whitespace-nowrap rounded border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-xs text-slate-600">
                    {platformKeys(b.keys, platform)}
                  </kbd>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setRecording(isRecording ? null : id);
                  }}
                  className="rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-100"
                >
                  {t("shortcutChange")}
                </button>
                {prefs.customKeys[id] && !isRecording && (
                  <button
                    type="button"
                    onClick={() => onChange(resetCustomKey(prefs, id))}
                    className="rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-100"
                  >
                    {t("shortcutReset")}
                  </button>
                )}
              </div>
              {error?.id === id && (
                <p className="mt-1 text-xs text-red-600" role="alert">
                  {error.text}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {anyCustom && (
        <button
          type="button"
          onClick={() => {
            setRecording(null);
            setError(null);
            onChange({ ...prefs, customKeys: {} });
          }}
          className="mt-1.5 rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-100"
        >
          {t("shortcutResetAll")}
        </button>
      )}
    </section>
  );
}
