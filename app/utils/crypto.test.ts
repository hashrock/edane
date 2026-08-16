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
