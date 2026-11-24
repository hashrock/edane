/**
 * Application layer: assigning a key from the settings dialog.
 *
 * buildKeymap already ignores a custom key that collides (so storage can
 * never break the keymap); this is the up-front check that lets the dialog
 * refuse such a key with a reason instead of saving one that silently
 * doesn't work. A key is checked against the keymap in BOTH selection-mode
 * settings, so flipping that switch later can't turn a saved key dead.
 */

import { buildKeymap, customKeyConflict, type KeyBinding } from "./editorKeymap";
import type { EditorPreferences } from "./editorPreferences";
import {
  comboProblem,
  formatCombo,
  type ComboProblem,
  type CustomKeyId,
  type CustomKeys,
  type KeyCombo,
} from "./keyCombo";

export type AssignResult =
  | { ok: true; prefs: EditorPreferences }
  | { ok: false; problem: ComboProblem }
  | { ok: false; problem: "conflict"; conflict: KeyBinding };

function without(custom: CustomKeys, id: CustomKeyId): CustomKeys {
  const rest = { ...custom };
  delete rest[id];
  return rest;
}

/** `id` back on its built-in key. */
export function resetCustomKey(prefs: EditorPreferences, id: CustomKeyId): EditorPreferences {
  return { ...prefs, customKeys: without(prefs.customKeys, id) };
}

export function assignCustomKey(
  prefs: EditorPreferences,
  id: CustomKeyId,
  combo: KeyCombo
): AssignResult {
  const problem = comboProblem(combo);
  if (problem) return { ok: false, problem };
  const rest = without(prefs.customKeys, id);
  for (const selectionMode of [true, false]) {
    const keymap = buildKeymap({ ...prefs, selectionMode, customKeys: rest }, "canvas");
    const conflict = customKeyConflict(keymap, id, combo);
    if (conflict) return { ok: false, problem: "conflict", conflict };
  }
  // Choosing the built-in key again is a reset, not an override.
  const builtIn = buildKeymap({ ...prefs, customKeys: {} }, "canvas").find((b) => b.id === id);
  if (builtIn && builtIn.keys === formatCombo(combo)) {
    return { ok: true, prefs: { ...prefs, customKeys: rest } };
  }
  return { ok: true, prefs: { ...prefs, customKeys: { ...rest, [id]: combo } } };
}
