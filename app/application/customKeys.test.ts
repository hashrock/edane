import { describe, it, expect } from "vitest";
import { assignCustomKey, resetCustomKey } from "./customKeys";
import { DEFAULT_PREFERENCES } from "./editorPreferences";
import type { KeyCombo } from "./keyCombo";

const k = (key: string, mods: Partial<Omit<KeyCombo, "key">> = {}): KeyCombo => ({
  key,
  mod: true,
  shift: false,
  alt: false,
  ...mods,
});

describe("assignCustomKey", () => {
  it("stores a free, assignable key", () => {
    const r = assignCustomKey(DEFAULT_PREFERENCES, "bold", k("j"));
    expect(r.ok && r.prefs.customKeys).toEqual({ bold: k("j") });
  });

  it("refuses a key with a reason", () => {
    expect(assignCustomKey(DEFAULT_PREFERENCES, "bold", k("ArrowUp"))).toEqual({
      ok: false,
      problem: "fixed-key",
    });
    expect(assignCustomKey(DEFAULT_PREFERENCES, "bold", k("j", { mod: false }))).toEqual({
      ok: false,
      problem: "needs-modifier",
    });
    expect(assignCustomKey(DEFAULT_PREFERENCES, "bold", k("c"))).toEqual({
      ok: false,
      problem: "reserved",
    });
  });

  it("names the binding a taken key belongs to", () => {
    const r = assignCustomKey(DEFAULT_PREFERENCES, "bold", k("k"));
    expect(!r.ok && r.problem === "conflict" && r.conflict.id).toBe("palette");
  });

  it("checks the other selection-mode setting too", () => {
    // ⌘/Ctrl+Shift+Backspace only exists with selection mode off — refused
    // anyway as a fixed key; F2 is selection mode's "start editing".
    const always = { ...DEFAULT_PREFERENCES, selectionMode: false };
    const r = assignCustomKey(always, "present", k("F2", { mod: false }));
    expect(!r.ok && r.problem === "conflict" && r.conflict.id).toBe("sel-edit");
  });

  it("a key freed by another custom key can be taken", () => {
    const moved = assignCustomKey(DEFAULT_PREFERENCES, "bold", k("j"));
    if (!moved.ok) throw new Error("setup");
    const r = assignCustomKey(moved.prefs, "toggle-collapse", k("b"));
    expect(r.ok && r.prefs.customKeys).toEqual({ bold: k("j"), "toggle-collapse": k("b") });
  });

  it("choosing the built-in key again is a reset", () => {
    const moved = assignCustomKey(DEFAULT_PREFERENCES, "bold", k("j"));
    if (!moved.ok) throw new Error("setup");
    const back = assignCustomKey(moved.prefs, "bold", k("b"));
    expect(back.ok && back.prefs.customKeys).toEqual({});
    expect(resetCustomKey(moved.prefs, "bold").customKeys).toEqual({});
  });
});
