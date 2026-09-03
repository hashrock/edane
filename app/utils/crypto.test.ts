import { describe, expect, it } from "vitest";
import {
  decodeStoredNoteContent,
  encodeNoteContentForStorage,
  encrypt,
  isEncrypted,
  noteStorageMode,
} from "./crypto";

const SECRET = "test-secret";

describe("noteStorageMode", () => {
  it("maps public notes to plain and private notes to encrypted", () => {
    expect(noteStorageMode(true)).toBe("plain");
    expect(noteStorageMode(false)).toBe("encrypted");
  });
});

describe("decodeStoredNoteContent", () => {
  it("returns public content as-is without attempting decryption", async () => {
    expect(await decodeStoredNoteContent("plain text", "plain", SECRET)).toBe(
      "plain text"
    );
  });

  it("returns empty private content as-is", async () => {
    expect(await decodeStoredNoteContent("", "encrypted", SECRET)).toBe("");
  });

  it("returns legacy plaintext private content as-is (not encrypted)", async () => {
    expect(await decodeStoredNoteContent("legacy plain", "encrypted", SECRET)).toBe(
      "legacy plain"
    );
  });

  it("decrypts encrypted private content", async () => {
    const stored = await encrypt("secret note body", SECRET);
    expect(await decodeStoredNoteContent(stored, "encrypted", SECRET)).toBe(
      "secret note body"
    );
  });

  it("returns null when decryption fails", async () => {
    const stored = await encrypt("secret note body", SECRET);
    expect(await decodeStoredNoteContent(stored, "encrypted", "wrong-secret")).toBeNull();
  });
});

describe("encodeNoteContentForStorage", () => {
  it("stores public content as plaintext", async () => {
    expect(await encodeNoteContentForStorage("hello", "plain", SECRET)).toBe("hello");
  });

  it("encrypts private content", async () => {
    const stored = await encodeNoteContentForStorage("secret note body", "encrypted", SECRET);
    expect(stored).not.toBe("secret note body");
    expect(isEncrypted(stored)).toBe(true);
  });

  it("round-trips through decodeStoredNoteContent", async () => {
    const stored = await encodeNoteContentForStorage("round trip", "encrypted", SECRET);
    expect(await decodeStoredNoteContent(stored, "encrypted", SECRET)).toBe("round trip");
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
    expect(await decodeStoredNoteContent(legacy, "encrypted", SECRET)).toBe(legacy);
  });

  it("still recognises an encrypted empty note", async () => {
    expect(isEncrypted(await encrypt("", SECRET))).toBe(true);
  });
});
