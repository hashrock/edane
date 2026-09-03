/**
 * Property-based tests for editor preferences persistence: whatever is in
 * storage — a saved set, a hand-edited partial object, garbage — loading
 * yields a complete, valid preference set where every recognised value is
 * kept and everything else falls back to the default.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { memoryStorage } from "./browserStorage";
import {
  DEFAULT_PREFERENCES,
  loadPreferences,
  PREFERENCES_KEY,
  savePreferences,
  type EditorPreferences,
} from "./editorPreferences";

const VALID = {
  selectionMode: [true, false],
  tabBehavior: ["indent", "insert-child"],
  enterBehavior: ["insert-sibling", "edit"],
  arrowBehavior: ["collapse", "navigate"],
} as const satisfies Record<keyof EditorPreferences, readonly unknown[]>;

const prefsArb: fc.Arbitrary<EditorPreferences> = fc.record({
  selectionMode: fc.constantFrom(...VALID.selectionMode),
  tabBehavior: fc.constantFrom(...VALID.tabBehavior),
  enterBehavior: fc.constantFrom(...VALID.enterBehavior),
  arrowBehavior: fc.constantFrom(...VALID.arrowBehavior),
});

function expectValid(p: EditorPreferences) {
  for (const key of Object.keys(VALID) as (keyof EditorPreferences)[]) {
    expect(VALID[key] as readonly unknown[]).toContain(p[key]);
  }
  expect(Object.keys(p).sort()).toEqual(Object.keys(DEFAULT_PREFERENCES).sort());
}

describe("preferences persistence", () => {
  it("loadPreferences(savePreferences(p)) === p", () => {
    fc.assert(
      fc.property(prefsArb, (prefs) => {
        const storage = memoryStorage();
        savePreferences(prefs, storage);
        expect(loadPreferences(storage)).toEqual(prefs);
      })
    );
  });

  it("any stored string loads to a valid, complete preference set without throwing", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ unit: "grapheme" }), fc.json()), (raw) => {
        const storage = memoryStorage();
        storage.setItem(PREFERENCES_KEY, raw);
        expectValid(loadPreferences(storage));
      })
    );
  });

  it("a partial / hand-edited object keeps each recognised value and defaults the rest", () => {
    // Inherited property names are the classic way an `in` check lets junk
    // through, so they are drawn explicitly rather than left to chance.
    const junk = fc.oneof(
      fc.jsonValue(),
      fc.constantFrom("toString", "constructor", "hasOwnProperty", "__proto__", "valueOf")
    );
    const loose = fc.record(
      {
        selectionMode: junk,
        tabBehavior: junk,
        enterBehavior: junk,
        arrowBehavior: junk,
        somethingElse: fc.jsonValue(),
      },
      { requiredKeys: [] }
    );
    fc.assert(
      fc.property(loose, (stored) => {
        const storage = memoryStorage();
        storage.setItem(PREFERENCES_KEY, JSON.stringify(stored));
        const loaded = loadPreferences(storage);
        expectValid(loaded);
        for (const key of Object.keys(VALID) as (keyof EditorPreferences)[]) {
          const given = (stored as Record<string, unknown>)[key];
          const recognised = (VALID[key] as readonly unknown[]).includes(given);
          expect(loaded[key]).toBe(recognised ? given : DEFAULT_PREFERENCES[key]);
        }
      })
    );
  });
});
