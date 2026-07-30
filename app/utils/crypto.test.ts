import { describe, expect, it } from "vitest";
import { decodeStoredNoteContent, encrypt } from "./crypto";

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
