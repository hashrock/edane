import { describe, it, expect } from "vitest";
import type { EditorPreferences } from "./editorPreferences";
import { memoryStorage } from "./browserStorage";
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_KEY,
  loadPreferences,
  savePreferences,
} from "./editorPreferences";

describe("loadPreferences", () => {
  it("returns the defaults when nothing is stored", () => {
    expect(loadPreferences(memoryStorage())).toEqual(DEFAULT_PREFERENCES);
  });

  it("returns the defaults when storage is unavailable (SSR)", () => {
    expect(loadPreferences(undefined)).toEqual(DEFAULT_PREFERENCES);
  });

  it("round-trips a saved preference set", () => {
    const storage = memoryStorage();
    const prefs = {
      selectionMode: false,
      tabBehavior: "insert-child",
      enterBehavior: "edit",
      arrowBehavior: "navigate",
    } as const;
    savePreferences(prefs, storage);
    expect(loadPreferences(storage)).toEqual(prefs);
  });

  it("falls back per-field on invalid values", () => {
    const storage = memoryStorage();
    storage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({
        selectionMode: "yes",
        tabBehavior: "insert-child",
        enterBehavior: "edit",
        arrowBehavior: "sideways",
      })
    );
    expect(loadPreferences(storage)).toEqual({
      selectionMode: true,
      tabBehavior: "insert-child",
      enterBehavior: "edit",
      arrowBehavior: DEFAULT_PREFERENCES.arrowBehavior,
    });
  });

  it("falls back to the defaults on unparsable JSON", () => {
    const storage = memoryStorage();
    storage.setItem(PREFERENCES_KEY, "{nope");
    expect(loadPreferences(storage)).toEqual(DEFAULT_PREFERENCES);
  });

  it("accepts every declared tabBehavior/enterBehavior/arrowBehavior literal", () => {
    // Spelled out so this test fails to typecheck (not just at runtime) if a
    // member is ever renamed without updating the list below.
    const tabBehaviors: EditorPreferences["tabBehavior"][] = [
      "indent",
      "insert-child",
    ];
    const enterBehaviors: EditorPreferences["enterBehavior"][] = [
      "insert-sibling",
      "edit",
    ];
    const arrowBehaviors: EditorPreferences["arrowBehavior"][] = [
      "collapse",
      "navigate",
    ];
    const storage = memoryStorage();
    for (const tabBehavior of tabBehaviors) {
      storage.setItem(
        PREFERENCES_KEY,
        JSON.stringify({ ...DEFAULT_PREFERENCES, tabBehavior })
      );
      expect(loadPreferences(storage).tabBehavior).toBe(tabBehavior);
    }
    for (const enterBehavior of enterBehaviors) {
      storage.setItem(
        PREFERENCES_KEY,
        JSON.stringify({ ...DEFAULT_PREFERENCES, enterBehavior })
      );
      expect(loadPreferences(storage).enterBehavior).toBe(enterBehavior);
    }
    for (const arrowBehavior of arrowBehaviors) {
      storage.setItem(
        PREFERENCES_KEY,
        JSON.stringify({ ...DEFAULT_PREFERENCES, arrowBehavior })
      );
      expect(loadPreferences(storage).arrowBehavior).toBe(arrowBehavior);
    }
  });
});

describe("loadPreferences against prototype names", () => {
  // `"toString" in SET` is true via Object.prototype, which let a hand-edited
  // entry smuggle "toString" in as a behaviour value (found by the property
  // test). Membership must be own-property only.
  it("falls back to the default for inherited property names", () => {
    const storage = memoryStorage();
    storage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({ tabBehavior: "toString", enterBehavior: "constructor", arrowBehavior: "__proto__" })
    );
    expect(loadPreferences(storage)).toEqual(DEFAULT_PREFERENCES);
  });
});
