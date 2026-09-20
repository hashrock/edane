import { describe, it, expect } from "vitest";
import { memoryStorage } from "./browserStorage";
import {
  ARROW_BEHAVIORS,
  DEFAULT_PREFERENCES,
  ENTER_BEHAVIORS,
  PREFERENCES_KEY,
  TAB_BEHAVIORS,
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
    // Drawn from the exported *_BEHAVIORS arrays (derived from the same
    // exhaustive sets isTabBehavior/isEnterBehavior/isArrowBehavior use), so
    // this test automatically covers a newly added member instead of quietly
    // keeping only the old ones.
    const storage = memoryStorage();
    for (const tabBehavior of TAB_BEHAVIORS) {
      storage.setItem(
        PREFERENCES_KEY,
        JSON.stringify({ ...DEFAULT_PREFERENCES, tabBehavior })
      );
      expect(loadPreferences(storage).tabBehavior).toBe(tabBehavior);
    }
    for (const enterBehavior of ENTER_BEHAVIORS) {
      storage.setItem(
        PREFERENCES_KEY,
        JSON.stringify({ ...DEFAULT_PREFERENCES, enterBehavior })
      );
      expect(loadPreferences(storage).enterBehavior).toBe(enterBehavior);
    }
    for (const arrowBehavior of ARROW_BEHAVIORS) {
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
