import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_KEY,
  loadPreferences,
  savePreferences,
} from "./editorPreferences";

// The node test project has no DOM — back localStorage with a plain Map.
function stubLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
}

beforeEach(stubLocalStorage);
afterEach(() => vi.unstubAllGlobals());

describe("loadPreferences", () => {
  it("returns the defaults when nothing is stored", () => {
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it("returns the defaults when localStorage is unavailable (SSR)", () => {
    vi.unstubAllGlobals();
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it("round-trips a saved preference set", () => {
    const prefs = {
      selectionMode: false,
      tabBehavior: "insert-child",
      arrowBehavior: "navigate",
    } as const;
    savePreferences(prefs);
    expect(loadPreferences()).toEqual(prefs);
  });

  it("falls back per-field on invalid values", () => {
    localStorage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({
        selectionMode: "yes",
        tabBehavior: "insert-child",
        arrowBehavior: "sideways",
      })
    );
    expect(loadPreferences()).toEqual({
      selectionMode: true,
      tabBehavior: "insert-child",
      arrowBehavior: "collapse",
    });
  });

  it("falls back to the defaults on unparsable JSON", () => {
    localStorage.setItem(PREFERENCES_KEY, "{nope");
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
  });
});
