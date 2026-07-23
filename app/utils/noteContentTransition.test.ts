import { describe, expect, it } from "vitest";
import { resolveNoteContentAction } from "./noteContentTransition";

describe("resolveNoteContentAction", () => {
  it("encrypts new content when the note stays/becomes private", () => {
    expect(
      resolveNoteContentAction({
        currentIsPublic: false,
        currentContent: "old",
        requestedIsPublic: undefined,
        requestedContent: "new",
      })
    ).toEqual({ kind: "encrypt", content: "new" });

    expect(
      resolveNoteContentAction({
        currentIsPublic: true,
        currentContent: "old",
        requestedIsPublic: false,
        requestedContent: "new",
      })
    ).toEqual({ kind: "encrypt", content: "new" });
  });

  it("stores new content as plaintext when the note stays/becomes public", () => {
    expect(
      resolveNoteContentAction({
        currentIsPublic: true,
        currentContent: "old",
        requestedIsPublic: undefined,
        requestedContent: "new",
      })
    ).toEqual({ kind: "store-plain", content: "new" });

    expect(
      resolveNoteContentAction({
        currentIsPublic: false,
        currentContent: "old",
        requestedIsPublic: true,
        requestedContent: "new",
      })
    ).toEqual({ kind: "store-plain", content: "new" });
  });

  it("re-encrypts existing content on public -> private with no new content", () => {
    expect(
      resolveNoteContentAction({
        currentIsPublic: true,
        currentContent: "plaintext",
        requestedIsPublic: false,
        requestedContent: undefined,
      })
    ).toEqual({ kind: "encrypt", content: "plaintext" });
  });

  it("decrypts existing content on private -> public with no new content", () => {
    expect(
      resolveNoteContentAction({
        currentIsPublic: false,
        currentContent: "ciphertext",
        requestedIsPublic: true,
        requestedContent: undefined,
      })
    ).toEqual({ kind: "decrypt-if-encrypted", content: "ciphertext" });
  });

  it("leaves content unchanged when neither content nor publicity actually changes", () => {
    expect(
      resolveNoteContentAction({
        currentIsPublic: false,
        currentContent: "stored",
        requestedIsPublic: undefined,
        requestedContent: undefined,
      })
    ).toEqual({ kind: "unchanged" });

    expect(
      resolveNoteContentAction({
        currentIsPublic: true,
        currentContent: "stored",
        requestedIsPublic: true,
        requestedContent: undefined,
      })
    ).toEqual({ kind: "unchanged" });

    expect(
      resolveNoteContentAction({
        currentIsPublic: false,
        currentContent: "stored",
        requestedIsPublic: false,
        requestedContent: undefined,
      })
    ).toEqual({ kind: "unchanged" });
  });
});
