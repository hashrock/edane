import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  buildKeymap,
  customKeyConflict,
  type KeyBinding,
  type KeymapKeyEvent,
} from "./editorKeymap";
import { DEFAULT_PREFERENCES, type EditorPreferences } from "./editorPreferences";
import {
  CUSTOM_KEY_IDS,
  comboFromEvent,
  comboMatches,
  comboProblem,
  formatCombo,
  type KeyCombo,
} from "./keyCombo";
import { customKeysArb, layoutArb, prefsArb } from "./editorState.arb";
import { menuShortcut } from "./menuShortcuts";

const combo = (key: string, mods: Partial<Omit<KeyCombo, "key">> = {}): KeyCombo => ({
  key,
  mod: false,
  shift: false,
  alt: false,
  ...mods,
});
const press = (key: string, mods: Partial<KeymapKeyEvent> = {}): KeymapKeyEvent => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});
const withKeys = (customKeys: EditorPreferences["customKeys"], base = DEFAULT_PREFERENCES) =>
  buildKeymap({ ...base, customKeys }, "canvas");
/** Which binding a key reaches (first match, any scope — enough for chords). */
const hit = (bindings: KeyBinding[], e: KeymapKeyEvent) => bindings.find((b) => b.match(e))?.id;

describe("comboProblem", () => {
  it("never lets a navigation or editing key be assigned", () => {
    for (const key of ["ArrowUp", "ArrowLeft", "Enter", "Tab", "Backspace", "Delete", "Escape", " ", "Home"]) {
      expect(comboProblem(combo(key, { mod: true }))).toBe("fixed-key");
    }
    expect(comboProblem(combo("Shift", { shift: true }))).toBe("fixed-key");
  });

  it("needs ⌘/Ctrl unless it is a function key", () => {
    expect(comboProblem(combo("j"))).toBe("needs-modifier");
    expect(comboProblem(combo("j", { alt: true }))).toBe("needs-modifier");
    expect(comboProblem(combo("j", { mod: true }))).toBeNull();
    expect(comboProblem(combo("F7"))).toBeNull();
  });

  it("keeps the browser's and text editing's chords", () => {
    for (const key of ["c", "v", "x", "a", "z", "w", "t", "r", "1"]) {
      expect(comboProblem(combo(key, { mod: true }))).toBe("reserved");
    }
    expect(comboProblem(combo("F12"))).toBe("reserved");
  });
});

describe("combo round trip", () => {
  it("records what a keydown spells and matches it back exactly", () => {
    const e = press("J", { metaKey: true, shiftKey: true });
    const c = comboFromEvent(e);
    expect(c).toEqual(combo("j", { mod: true, shift: true }));
    expect(comboMatches(c, e)).toBe(true);
    expect(comboMatches(c, press("j", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(comboMatches(c, press("j", { metaKey: true }))).toBe(false);
    expect(formatCombo(c)).toBe("⌘/Ctrl + Shift + J");
  });
});

describe("buildKeymap with custom keys", () => {
  it("moves a binding to its new key", () => {
    const km = withKeys({ bold: combo("j", { mod: true }) });
    expect(hit(km, press("j", { metaKey: true }))).toBe("bold");
    expect(hit(km, press("b", { metaKey: true }))).toBeUndefined();
    expect(km.find((b) => b.id === "bold")?.keys).toBe("⌘/Ctrl + J");
    // The context menu reads the same table.
    expect(menuShortcut(km, "bold")).toBe("⌘/Ctrl + J");
  });

  it("lets two bindings trade keys", () => {
    const km = withKeys({
      bold: combo(".", { mod: true }),
      "toggle-collapse": combo("b", { mod: true }),
    });
    expect(hit(km, press(".", { metaKey: true }))).toBe("bold");
    expect(hit(km, press("b", { ctrlKey: true }))).toBe("toggle-collapse");
  });

  it("ignores a key another binding already answers to", () => {
    const km = withKeys({ bold: combo("k", { mod: true }) }); // ⌘K = palette
    expect(hit(km, press("k", { metaKey: true }))).toBe("palette");
    expect(hit(km, press("b", { metaKey: true }))).toBe("bold");
  });

  it("only offers bindings whose built-in key is assignable", () => {
    // Moving one off a fixed key would change what that fixed key does.
    for (const prefs of [DEFAULT_PREFERENCES, { ...DEFAULT_PREFERENCES, selectionMode: false }]) {
      const km = buildKeymap(prefs, "canvas");
      for (const id of CUSTOM_KEY_IDS) {
        const b = km.find((x) => x.id === id)!;
        for (const keys of b.keys.split(" / ")) {
          const parts = keys.split(" + ");
          const key = parts[parts.length - 1];
          const c = combo(key.length === 1 ? key.toLowerCase() : key, {
            mod: parts.includes("⌘/Ctrl"),
            shift: parts.includes("Shift"),
            alt: parts.includes("Alt"),
          });
          expect(comboProblem(c), `${id}: ${keys}`).toBeNull();
        }
      }
    }
  });

  it("whatever is stored, no custom key overlaps another binding", () => {
    fc.assert(
      fc.property(prefsArb, layoutArb, (prefs, layout) => {
        const km = buildKeymap(prefs, layout);
        for (const id of CUSTOM_KEY_IDS) {
          const c = prefs.customKeys[id];
          const b = km.find((x) => x.id === id);
          if (!c || !b || b.keys !== formatCombo(c)) continue; // not applied
          expect(comboProblem(c)).toBeNull();
          expect(customKeyConflict(km, id, c)).toBeNull();
        }
      })
    );
  });

  it("whatever is stored, the fixed keys reach the same bindings", () => {
    const FIXED = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Tab", "Backspace", "Delete", "Escape", " "];
    const mods: Partial<KeymapKeyEvent>[] = [{}, { shiftKey: true }, { altKey: true }, { metaKey: true }, { metaKey: true, shiftKey: true }];
    fc.assert(
      fc.property(prefsArb, layoutArb, customKeysArb, (prefs, layout, customKeys) => {
        const plain = buildKeymap({ ...prefs, customKeys: {} }, layout);
        const custom = buildKeymap({ ...prefs, customKeys }, layout);
        for (const key of FIXED) {
          for (const m of mods) {
            const e = press(key, m);
            expect(hit(custom, e)).toBe(hit(plain, e));
          }
        }
      })
    );
  });
});
