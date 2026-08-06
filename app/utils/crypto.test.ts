import { describe, expect, it } from "vitest";
import { decodeStoredNoteContent, encodeNoteContentForStorage, encrypt, isEncrypted } from "./crypto";

const SECRET = "test-secret";

describe("decodeStoredNoteContent", () => {
  it("returns public content as-is without attempting decryption", async () => {
    expect(await decodeStoredNoteContent("plain text", true, SECRET)).toBe(
      "plain text"
    );
  });

  it("returns empty private content as-is", async () => {
    expect(await decodeStoredNoteContent("", false, SECRET)).toBe("");
  });

  it("returns legacy plaintext private content as-is (not encrypted)", async () => {
    expect(await decodeStoredNoteContent("legacy plain", false, SECRET)).toBe(
      "legacy plain"
    );
  });

  it("decrypts encrypted private content", async () => {
    const stored = await encrypt("secret note body", SECRET);
    expect(await decodeStoredNoteContent(stored, false, SECRET)).toBe(
      "secret note body"
    );
  });

  it("returns null when decryption fails", async () => {
    const stored = await encrypt("secret note body", SECRET);
    expect(await decodeStoredNoteContent(stored, false, "wrong-secret")).toBeNull();
  });
});

describe("encodeNoteContentForStorage", () => {
  it("stores public content as plaintext", async () => {
    expect(await encodeNoteContentForStorage("hello", true, SECRET)).toBe("hello");
  });

  it("encrypts private content", async () => {
    const stored = await encodeNoteContentForStorage("secret note body", false, SECRET);
    expect(stored).not.toBe("secret note body");
    expect(isEncrypted(stored)).toBe(true);
  });

  it("round-trips through decodeStoredNoteContent", async () => {
    const stored = await encodeNoteContentForStorage("round trip", false, SECRET);
    expect(await decodeStoredNoteContent(stored, false, SECRET)).toBe("round trip");
  });
});
