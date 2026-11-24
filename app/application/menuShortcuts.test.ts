import { describe, it, expect } from "vitest";
import { buildKeymap, type KeyBinding, type KeymapKeyEvent } from "./editorKeymap";
import {
  ARROW_BEHAVIORS,
  DEFAULT_PREFERENCES,
  ENTER_BEHAVIORS,
  TAB_BEHAVIORS,
  type EditorPreferences,
} from "./editorPreferences";
import {
  MENU_SHORTCUT_BINDINGS,
  detectKeyPlatform,
  menuShortcut,
  platformKeys,
  type MenuCommand,
} from "./menuShortcuts";

/** Every keyboard-relevant preference combination (branchSpacing is display-only). */
const ALL_PREFS: EditorPreferences[] = [true, false].flatMap((selectionMode) =>
  TAB_BEHAVIORS.flatMap((tabBehavior) =>
    ENTER_BEHAVIORS.flatMap((enterBehavior) =>
      ARROW_BEHAVIORS.map((arrowBehavior) => ({
        ...DEFAULT_PREFERENCES,
        selectionMode,
        tabBehavior,
        enterBehavior,
        arrowBehavior,
      }))
    )
  )
);

const COMMANDS = Object.keys(MENU_SHORTCUT_BINDINGS) as MenuCommand[];

const KEY_NAMES: Record<string, string> = {
  "↑": "ArrowUp",
  "↓": "ArrowDown",
  "←": "ArrowLeft",
  "→": "ArrowRight",
  Esc: "Escape",
  Space: " ",
};

/** Turn a displayed hint ("⌘/Ctrl + Shift + D") back into the key it names. */
function pressFor(hint: string): KeymapKeyEvent {
  const e: KeymapKeyEvent = {
    key: "",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
  };
  for (const part of hint.split(" + ")) {
    if (part === "⌘/Ctrl") e.metaKey = true;
    else if (part === "Shift") e.shiftKey = true;
    else if (part === "Alt") e.altKey = true;
    else e.key = KEY_NAMES[part] ?? part;
  }
  return e;
}

/**
 * The binding runKeymap would pick for `e` with a node active, in the mode the
 * user is in when they reach for the key (mirrors runKeymap's scope rule).
 */
function firstMatch(
  bindings: KeyBinding[],
  prefs: EditorPreferences,
  e: KeymapKeyEvent
): KeyBinding | undefined {
  const mode = prefs.selectionMode ? "selection" : "editing";
  return bindings.find(
    (b) =>
      (b.when === "global" || b.when === "both" || b.when === mode) &&
      b.match(e)
  );
}

describe("menuShortcut", () => {
  it("every hinted key fires a binding that does the menu item's job", () => {
    for (const prefs of ALL_PREFS) {
      const keymap = buildKeymap(prefs, "canvas");
      for (const command of COMMANDS) {
        const hint = menuShortcut(keymap, command);
        if (hint === undefined) continue;
        const hit = firstMatch(keymap, prefs, pressFor(hint));
        expect(
          hit && (MENU_SHORTCUT_BINDINGS[command] as readonly string[]).includes(hit.id),
          `${command} → "${hint}" under ${JSON.stringify(prefs)} fired ${hit?.id}`
        ).toBe(true);
      }
    }
  });

  it("names only binding ids that exist in some keymap", () => {
    const ids = new Set(
      ALL_PREFS.flatMap((p) => buildKeymap(p, "canvas").map((b) => b.id))
    );
    for (const command of COMMANDS) {
      for (const id of MENU_SHORTCUT_BINDINGS[command]) {
        expect(ids.has(id), `${command}: ${id}`).toBe(true);
      }
    }
  });

  it("follows the preferences instead of stating fixed keys", () => {
    const def = buildKeymap(DEFAULT_PREFERENCES, "canvas");
    expect(menuShortcut(def, "addSibling")).toBe("Enter");
    expect(menuShortcut(def, "addChild")).toBe("Tab");
    expect(menuShortcut(def, "outdent")).toBe("Shift + Tab");
    expect(menuShortcut(def, "indent")).toBe("Alt + →");
    expect(menuShortcut(def, "delete")).toBe("Backspace");
    expect(menuShortcut(def, "shortcutList")).toBe("?");

    const swapped = buildKeymap({ ...DEFAULT_PREFERENCES, enterBehavior: "edit" }, "canvas");
    expect(menuShortcut(swapped, "addSibling")).toBe("⌘/Ctrl + Enter");
    expect(menuShortcut(swapped, "edit")).toBe("Enter");

    // Tab indents: nothing on the keyboard adds a child, so no hint.
    const indent = buildKeymap({ ...DEFAULT_PREFERENCES, tabBehavior: "indent" }, "canvas");
    expect(menuShortcut(indent, "addChild")).toBeUndefined();
    expect(menuShortcut(indent, "indent")).toBe("Tab");
    expect(menuShortcut(indent, "outdent")).toBe("Shift + Tab");

    // Always-edit: the chorded replacements.
    const always = buildKeymap({ ...DEFAULT_PREFERENCES, selectionMode: false }, "canvas");
    expect(menuShortcut(always, "delete")).toBe("⌘/Ctrl + Shift + Backspace");
    expect(menuShortcut(always, "shortcutList")).toBe("⌘/Ctrl + /");
    expect(menuShortcut(always, "edit")).toBeUndefined();
  });
});

describe("platformKeys", () => {
  it("shows the modifier the user has", () => {
    expect(platformKeys("⌘/Ctrl + Shift + D", "mac")).toBe("⌘ + Shift + D");
    expect(platformKeys("⌘/Ctrl + .", "other")).toBe("Ctrl + .");
    expect(platformKeys("Alt + ↑", "mac")).toBe("Alt + ↑");
  });

  it("detects Apple platforms", () => {
    expect(detectKeyPlatform({ platform: "MacIntel" })).toBe("mac");
    expect(detectKeyPlatform({ userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0)" })).toBe("mac");
    expect(detectKeyPlatform({ platform: "Win32", userAgent: "Windows NT" })).toBe("other");
    expect(detectKeyPlatform(null)).toBe("other");
  });
});
