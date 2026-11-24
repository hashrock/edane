/**
 * Application layer: the key hint shown next to a context-menu item.
 *
 * The menu never states a key of its own. Each menu command names the keymap
 * bindings that do the same thing (in order of preference), and the hint is
 * read from whichever of them the CURRENT keymap actually contains — the one
 * `buildKeymap(prefs, layout)` built for this user's preferences. So the menu
 * follows the same rule as the `?` overlay: it only ever shows keys that fire.
 * Flip `enterBehavior` and "add sibling" shows ⌘/Ctrl+Enter instead of Enter;
 * switch `tabBehavior` to indent and "add child" loses its hint (nothing on the
 * keyboard adds a child then) rather than advertising a Tab that indents.
 */

import type { KeyBinding } from "./editorKeymap";

/**
 * Menu command → keymap binding ids, most preferred first.
 * The ids are plain strings, so menuShortcuts.test.ts checks every one of
 * them exists in some keymap built from the preference space — a renamed
 * binding can't silently orphan a hint.
 */
export const MENU_SHORTCUT_BINDINGS = {
  edit: ["sel-edit"],
  addChild: ["sel-insert-child", "edit-insert-child"],
  addSibling: ["sel-insert-sibling"],
  toggleCollapse: ["toggle-collapse"],
  moveUp: ["reorder-up"],
  moveDown: ["reorder-down"],
  // Tab first when Tab indents ("Tab / Shift + Tab" is one binding for both
  // directions — see DIRECTIONAL_HALF); under insert-child Tab adds a child,
  // so indent falls back to the selection-only Alt+→ chord.
  indent: ["sel-indent", "indent-right", "edit-indent"],
  outdent: ["sel-outdent", "sel-indent", "outdent-left", "edit-outdent", "edit-indent"],
  toggleTask: ["toggle-task"],
  bold: ["bold"],
  delete: ["sel-delete", "edit-delete-branch"],
  shortcutList: ["sel-help", "help-slash"],
} as const satisfies Record<string, readonly string[]>;

export type MenuCommand = keyof typeof MENU_SHORTCUT_BINDINGS;

/**
 * For a one-direction command, which half of a both-directions binding's
 * `keys` ("Tab / Shift + Tab") to show.
 */
const DIRECTIONAL_HALF: Partial<Record<MenuCommand, number>> = {
  indent: 0,
  outdent: 1,
};

/**
 * The key hint for `command` under `bindings`, or undefined when no binding
 * in the current keymap performs it. A `keys` string with alternatives
 * ("Backspace / Delete") shows only the first — the menu has room for one
 * hint, and the `?` overlay still lists them all. "⌘/Ctrl" contains a slash
 * but no surrounding spaces, so it is never split.
 */
export function menuShortcut(
  bindings: readonly KeyBinding[],
  command: MenuCommand
): string | undefined {
  for (const id of MENU_SHORTCUT_BINDINGS[command]) {
    const b = bindings.find((x) => x.id === id);
    if (!b) continue;
    const alternatives = b.keys.split(" / ");
    // "Tab / Shift + Tab" is one binding for both directions: pick the half
    // this command means. Any other binding shows its first alternative.
    const half = DIRECTIONAL_HALF[command];
    if (half !== undefined && alternatives.length === 2) return alternatives[half];
    return alternatives[0];
  }
  return undefined;
}

export type KeyPlatform = "mac" | "other";

/**
 * The keymap writes the primary modifier as "⌘/Ctrl" so one string serves
 * every platform; on screen we show the one the user actually has.
 */
export function platformKeys(keys: string, platform: KeyPlatform): string {
  return keys.replaceAll("⌘/Ctrl", platform === "mac" ? "⌘" : "Ctrl");
}

/** Best-effort platform sniff (no navigator, e.g. SSR → "other"). */
export function detectKeyPlatform(
  nav: { platform?: string; userAgent?: string } | null =
    typeof navigator === "undefined" ? null : navigator
): KeyPlatform {
  if (!nav) return "other";
  const s = `${nav.platform ?? ""} ${nav.userAgent ?? ""}`;
  return /Mac|iPhone|iPad|iPod/.test(s) ? "mac" : "other";
}
