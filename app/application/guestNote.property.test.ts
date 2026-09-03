/**
 * Property-based tests for the guest-note stash: stash → take is the
 * identity, take consumes (a second take is empty), and whatever garbage the
 * key holds is consumed without throwing.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { memoryStorage } from "./browserStorage";
import { PENDING_NOTE_KEY, stashPendingNote, takePendingNote } from "./guestNote";

const noteArb = fc.record({
  title: fc.string({ unit: "grapheme", maxLength: 30 }),
  content: fc.string({ unit: "grapheme", maxLength: 200 }),
});

describe("stashPendingNote / takePendingNote", () => {
  it("take(stash(note)) === note, and the stash is consumed", () => {
    fc.assert(
      fc.property(noteArb, (note) => {
        const storage = memoryStorage();
        expect(stashPendingNote(note, storage)).toBe(true);
        expect(takePendingNote(storage)).toEqual(note);
        expect(storage.getItem(PENDING_NOTE_KEY)).toBeNull();
        expect(takePendingNote(storage)).toBeNull();
      })
    );
  });

  it("any stored value is consumed without throwing; only an object with a string content is a note", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ unit: "grapheme" }), fc.json()), (raw) => {
        const storage = memoryStorage();
        storage.setItem(PENDING_NOTE_KEY, raw);
        const taken = takePendingNote(storage);
        if (raw !== "") expect(storage.getItem(PENDING_NOTE_KEY)).toBeNull();
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          expect(taken).toBeNull();
          return;
        }
        const obj = parsed as { title?: unknown; content?: unknown } | null;
        if (!obj || typeof obj !== "object" || typeof obj.content !== "string") {
          expect(taken).toBeNull();
          return;
        }
        expect(taken).toEqual({
          title: typeof obj.title === "string" ? obj.title : "Untitled",
          content: obj.content,
        });
      })
    );
  });
});
