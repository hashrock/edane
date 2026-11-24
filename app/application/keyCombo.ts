/**
 * Application layer: user-assigned shortcut keys.
 *
 * A small, closed set of keymap bindings can be given a different key from
 * the settings dialog (stored in EditorPreferences.customKeys). Only chorded
 * "command" bindings are on the list — never the arrows, Enter, Tab,
 * Backspace/Delete, Escape or Space. Those carry the keyboard-escape
 * invariant (CLAUDE.md) and the text-editing conventions, and no assigned key
 * may take them either: {@link comboProblem} refuses a combo on those keys,
 * so an override can neither move an arrow nor shadow one.
 *
 * This module only knows about combos. Whether a combo collides with another
 * binding needs the keymap, which lives in editorKeymap.ts
 * (`customKeyConflict`).
 */

import { closedStringSet } from "../domain/isKeyOf";

/** A key plus modifiers. `mod` is ⌘ on macOS and Ctrl elsewhere. */
export interface KeyCombo {
  /** KeyboardEvent.key, lower-cased when it is a single letter. */
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

/**
 * Keymap binding ids whose key the user may change. `satisfies` + the closed
 * set keep the id list and its validator in one place.
 *
 * Only bindings whose BUILT-IN key is itself assignable: moving one off a
 * fixed key would hand that key to whatever matches it next (⌘/Ctrl+Shift+
 * Backspace would fall through to the textarea, Alt+↑ to the plain arrow
 * bindings), so Alt+↑↓ reorder and the always-edit branch delete stay put.
 */
const CUSTOM_KEY_ID_SET = {
  palette: true,
  present: true,
  "help-slash": true,
  bold: true,
  "toggle-task": true,
  "toggle-collapse": true,
} as const satisfies Record<string, true>;

export type CustomKeyId = keyof typeof CUSTOM_KEY_ID_SET;

const { is: isCustomKeyId, values: CUSTOM_KEY_IDS } =
  closedStringSet<CustomKeyId>(CUSTOM_KEY_ID_SET);
export { isCustomKeyId, CUSTOM_KEY_IDS };

export type CustomKeys = Partial<Record<CustomKeyId, KeyCombo>>;

/** Navigation and text-editing keys: never assignable, with or without modifiers. */
const FIXED_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "Escape",
  " ",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/** Pressing only a modifier is not a shortcut yet. */
const MODIFIER_KEYS = new Set(["Meta", "Control", "Shift", "Alt", "AltGraph", "CapsLock", "Fn", "OS"]);

/**
 * ⌘/Ctrl + these belong to the browser or to text editing (copy, paste, undo,
 * select all, find, print, save, new / close / reopen tab, reload, address
 * bar, switch tab by number) — the editor never takes them.
 */
const RESERVED_WITH_MOD = new Set([
  ..."acvxzyfpswtnqrlhm",
  ..."0123456789",
]);

/** F-keys the browser keeps (full screen, devtools). */
const RESERVED_PLAIN = new Set(["F11", "F12"]);

const isFunctionKey = (key: string) => /^F([1-9]|1[0-2])$/.test(key);

export type ComboProblem = "fixed-key" | "needs-modifier" | "reserved";

/**
 * Why `combo` can't be assigned at all (independent of the other bindings),
 * or null if it can. A combo must use ⌘/Ctrl — a plain or Alt-only letter
 * would type text while editing (Alt+letter types accented characters on
 * macOS) — unless it is a function key, which types nothing.
 */
export function comboProblem(combo: KeyCombo): ComboProblem | null {
  if (FIXED_KEYS.has(combo.key) || MODIFIER_KEYS.has(combo.key)) return "fixed-key";
  if (isFunctionKey(combo.key)) {
    return RESERVED_PLAIN.has(combo.key) ? "reserved" : null;
  }
  if (!combo.mod) return "needs-modifier";
  if (RESERVED_WITH_MOD.has(combo.key) && !combo.alt) return "reserved";
  return null;
}

/** The combo a keydown spells (what the settings dialog records). */
export function comboFromEvent(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): KeyCombo {
  return {
    key: e.key.length === 1 ? e.key.toLowerCase() : e.key,
    mod: e.metaKey || e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
  };
}

/** Exact match: the same key with exactly these modifiers. */
export function comboMatches(
  combo: KeyCombo,
  e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }
): boolean {
  return (
    (e.metaKey || e.ctrlKey) === combo.mod &&
    e.shiftKey === combo.shift &&
    e.altKey === combo.alt &&
    (e.key.length === 1 ? e.key.toLowerCase() : e.key) === combo.key
  );
}

const KEY_LABELS: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Esc",
  " ": "Space",
};

/**
 * In the keymap's own notation ("⌘/Ctrl + Shift + D"), so the help overlay,
 * the context menu and `platformKeys` treat it like any built-in binding.
 */
export function formatCombo(combo: KeyCombo): string {
  const parts: string[] = [];
  if (combo.mod) parts.push("⌘/Ctrl");
  if (combo.shift) parts.push("Shift");
  if (combo.alt) parts.push("Alt");
  parts.push(
    KEY_LABELS[combo.key] ??
      (combo.key.length === 1 ? combo.key.toUpperCase() : combo.key)
  );
  return parts.join(" + ");
}

export const sameCombo = (a: KeyCombo, b: KeyCombo) =>
  a.key === b.key && a.mod === b.mod && a.shift === b.shift && a.alt === b.alt;

function isCombo(v: unknown): v is KeyCombo {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.key === "string" &&
    c.key.length > 0 &&
    c.key.length <= 32 &&
    typeof c.mod === "boolean" &&
    typeof c.shift === "boolean" &&
    typeof c.alt === "boolean"
  );
}

/**
 * Validate stored custom keys (untrusted localStorage JSON): keep only known
 * ids with a well-formed, assignable combo, and drop the later of two ids
 * that claim the same combo. Collisions with the built-in bindings are
 * checked where the keymap is known (buildKeymap ignores such an override).
 */
export function parseCustomKeys(raw: unknown): CustomKeys {
  const out: CustomKeys = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const taken: KeyCombo[] = [];
  for (const id of CUSTOM_KEY_IDS) {
    if (!Object.hasOwn(raw, id)) continue;
    const v = (raw as Record<string, unknown>)[id];
    if (!isCombo(v) || comboProblem(v) !== null) continue;
    if (taken.some((t) => sameCombo(t, v))) continue;
    const combo = { key: v.key, mod: v.mod, shift: v.shift, alt: v.alt };
    out[id] = combo;
    taken.push(combo);
  }
  return out;
}
