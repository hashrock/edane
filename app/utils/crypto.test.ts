import { describe, expect, it } from "vitest";
import {
  decodeStoredNoteContent,
  encodeNoteContentForStorage,
  encrypt,
  isEncrypted,
  noteStorageMode,
} from "./crypto";

const NOTE_ID = "note-1";

const SECRET = "test-secret";

describe("noteStorageMode", () => {
  it("maps public notes to plain and private notes to encrypted", () => {
    expect(noteStorageMode(true)).toBe("plain");
    expect(noteStorageMode(false)).toBe("encrypted");
  });
});

describe("decodeStoredNoteContent", () => {
  it("returns public content as-is without attempting decryption", async () => {
    expect(await decodeStoredNoteContent("plain text", "plain", SECRET, NOTE_ID)).toBe(
      "plain text"
    );
  });

  it("returns empty private content as-is", async () => {
    expect(await decodeStoredNoteContent("", "encrypted", SECRET, NOTE_ID)).toBe("");
  });

  it("returns legacy plaintext private content as-is (not encrypted)", async () => {
    expect(await decodeStoredNoteContent("legacy plain", "encrypted", SECRET, NOTE_ID)).toBe(
      "legacy plain"
    );
  });

  it("decrypts encrypted private content", async () => {
    const stored = await encrypt("secret note body", SECRET);
    expect(await decodeStoredNoteContent(stored, "encrypted", SECRET, NOTE_ID)).toBe(
      "secret note body"
    );
  });

  it("returns null when decryption fails", async () => {
    const stored = await encrypt("secret note body", SECRET);
    expect(await decodeStoredNoteContent(stored, "encrypted", "wrong-secret", NOTE_ID)).toBeNull();
  });
});

describe("encodeNoteContentForStorage", () => {
  it("stores public content as plaintext", async () => {
    expect(await encodeNoteContentForStorage("hello", "plain", SECRET, NOTE_ID)).toBe("hello");
  });

  it("encrypts private content", async () => {
    const stored = await encodeNoteContentForStorage("secret note body", "encrypted", SECRET, NOTE_ID);
    expect(stored).not.toBe("secret note body");
    expect(stored).toMatch(/^v2:[0-9a-f]{8}:/);
  });

  it("round-trips through decodeStoredNoteContent", async () => {
    const stored = await encodeNoteContentForStorage("round trip", "encrypted", SECRET, NOTE_ID);
    expect(await decodeStoredNoteContent(stored, "encrypted", SECRET, NOTE_ID)).toBe("round trip");
  });
});

describe("isEncrypted on legacy plaintext", () => {
  // `atob` ignores ASCII whitespace, so a loose "does it decode?" check took
  // ordinary English prose for ciphertext once it was long enough — and the
  // failed decrypt then returned null, i.e. the note vanished.
  it("does not mistake prose with spaces for ciphertext", () => {
    expect(isEncrypted("hello world of mindmaps and more")).toBe(false);
  });

  it("does not mistake an indented legacy outline for ciphertext", () => {
    expect(isEncrypted("Shopping\n  milk and eggs\n  bread and butter")).toBe(false);
  });

  it("returns legacy prose as-is even when it is long", async () => {
    const legacy = "hello world of mindmaps and more";
    expect(await decodeStoredNoteContent(legacy, "encrypted", SECRET, NOTE_ID)).toBe(legacy);
  });

  it("still recognises an encrypted empty note", async () => {
    expect(isEncrypted(await encrypt("", SECRET))).toBe(true);
  });
});

describe("v2 envelope", () => {
  it("binds the ciphertext to its note: moved to another row, it doesn't decrypt", async () => {
    const stored = await encodeNoteContentForStorage("body", "encrypted", SECRET, "note-a");
    expect(await decodeStoredNoteContent(stored, "encrypted", SECRET, "note-a")).toBe("body");
    expect(await decodeStoredNoteContent(stored, "encrypted", SECRET, "note-b")).toBeNull();
  });

  it("reads content written with the previous key during a rotation, and writes with the current one", async () => {
    const old = await encodeNoteContentForStorage("body", "encrypted", "old-key", NOTE_ID);
    const rotating = { current: "new-key", previous: "old-key" };
    expect(await decodeStoredNoteContent(old, "encrypted", rotating, NOTE_ID)).toBe("body");
    expect(await decodeStoredNoteContent(old, "encrypted", "new-key", NOTE_ID)).toBeNull();
    const rewritten = await encodeNoteContentForStorage("body", "encrypted", rotating, NOTE_ID);
    expect(await decodeStoredNoteContent(rewritten, "encrypted", "new-key", NOTE_ID)).toBe("body");
  });

  it("still reads legacy v1 ciphertext, with either key", async () => {
    const legacy = await encrypt("legacy body", "old-key");
    expect(await decodeStoredNoteContent(legacy, "encrypted", { current: "new-key", previous: "old-key" }, NOTE_ID)).toBe(
      "legacy body"
    );
  });
});
