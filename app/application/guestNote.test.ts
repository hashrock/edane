import { describe, it, expect } from "vitest";
import { memoryStorage } from "./browserStorage";
import { PENDING_NOTE_KEY, stashPendingNote, takePendingNote } from "./guestNote";

describe("stashPendingNote / takePendingNote", () => {
  it("round-trips a stashed note", () => {
    const storage = memoryStorage();
    expect(stashPendingNote({ title: "Untitled", content: "{}" }, storage)).toBe(true);
    expect(takePendingNote(storage)).toEqual({ title: "Untitled", content: "{}" });
  });

  it("consumes the note so a second read returns null", () => {
    const storage = memoryStorage();
    stashPendingNote({ title: "Note", content: "{}" }, storage);
    takePendingNote(storage);
    expect(takePendingNote(storage)).toBeNull();
  });

  it("returns null when nothing is stored", () => {
    expect(takePendingNote(memoryStorage())).toBeNull();
  });

  it("returns null and drops entries without string content", () => {
    const storage = memoryStorage();
    storage.setItem(PENDING_NOTE_KEY, JSON.stringify({ title: "Note" }));
    expect(takePendingNote(storage)).toBeNull();
  });

  it("falls back to 'Untitled' when title is missing", () => {
    const storage = memoryStorage();
    storage.setItem(PENDING_NOTE_KEY, JSON.stringify({ content: "{}" }));
    expect(takePendingNote(storage)).toEqual({ title: "Untitled", content: "{}" });
  });

  it("falls back to the defaults on unparsable JSON", () => {
    const storage = memoryStorage();
    storage.setItem(PENDING_NOTE_KEY, "{nope");
    expect(takePendingNote(storage)).toBeNull();
  });

  it("returns false/null without a storage (SSR)", () => {
    expect(stashPendingNote({ title: "Note", content: "{}" }, undefined)).toBe(false);
    expect(takePendingNote(undefined)).toBeNull();
  });
});
