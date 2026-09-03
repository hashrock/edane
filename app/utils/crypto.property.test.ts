/**
 * Property-based tests for the note-content crypto boundary: encrypt/decrypt
 * are inverses for any text and secret, the storage encode/decode pair is an
 * identity in both storage modes, and `isEncrypted` — the heuristic that
 * decides whether a stored private note still needs decrypting — says yes for
 * every ciphertext we produce and no for anything that looks like a note.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  decodeStoredNoteContent,
  decrypt,
  encodeNoteContentForStorage,
  encrypt,
  isEncrypted,
  noteStorageMode,
} from "./crypto";

const textArb = fc.string({ unit: "grapheme", maxLength: 80 });
const secretArb = fc.string({ unit: "grapheme", minLength: 1, maxLength: 24 });
const modeArb = fc.constantFrom("plain", "encrypted") as fc.Arbitrary<"plain" | "encrypted">;

describe("encrypt / decrypt", () => {
  it("decrypt(encrypt(text, secret), secret) === text, and the ciphertext is recognised", async () => {
    await fc.assert(
      fc.asyncProperty(textArb, secretArb, async (text, secret) => {
        const stored = await encrypt(text, secret);
        expect(isEncrypted(stored)).toBe(true);
        expect(stored).not.toBe(text);
        expect(await decrypt(stored, secret)).toBe(text);
      }),
      { numRuns: 60 }
    );
  });

  it("a different secret cannot decrypt (GCM authentication fails)", async () => {
    await fc.assert(
      fc.asyncProperty(textArb, secretArb, secretArb, async (text, a, b) => {
        fc.pre(a !== b);
        const stored = await encrypt(text, a);
        await expect(decrypt(stored, b)).rejects.toBeDefined();
      }),
      { numRuns: 30 }
    );
  });
});

describe("storage encode / decode", () => {
  it("decodeStoredNoteContent(encodeNoteContentForStorage(c)) === c in both modes", async () => {
    await fc.assert(
      fc.asyncProperty(textArb, modeArb, secretArb, async (content, mode, secret) => {
        const stored = await encodeNoteContentForStorage(content, mode, secret);
        expect(await decodeStoredNoteContent(stored, mode, secret)).toBe(content);
      }),
      { numRuns: 60 }
    );
  });

  it("public notes are stored verbatim, private notes never are", async () => {
    await fc.assert(
      fc.asyncProperty(textArb, fc.boolean(), secretArb, async (content, isPublic, secret) => {
        const stored = await encodeNoteContentForStorage(content, noteStorageMode(isPublic), secret);
        expect(stored === content).toBe(isPublic);
      }),
      { numRuns: 40 }
    );
  });
});

describe("isEncrypted never mistakes a note for ciphertext", () => {
  it("any JSON object/array is never taken for ciphertext", () => {
    fc.assert(
      fc.property(
        fc.jsonValue().filter((v) => typeof v === "object" && v !== null),
        (value) => {
          expect(isEncrypted(JSON.stringify(value))).toBe(false);
        }
      )
    );
  });

  it("text containing whitespace or any non-base64 character is never taken for ciphertext", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: "grapheme", maxLength: 120 }).filter((s) => /[^A-Za-z0-9+/=]/.test(s)),
        (text) => {
          expect(isEncrypted(text)).toBe(false);
        }
      )
    );
  });

  it("legacy plaintext private notes survive decoding unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ unit: "grapheme", maxLength: 120 }).filter((s) => /[^A-Za-z0-9+/=]/.test(s)),
        secretArb,
        async (legacy, secret) => {
          expect(await decodeStoredNoteContent(legacy, "encrypted", secret)).toBe(legacy);
        }
      ),
      { numRuns: 60 }
    );
  });
});
