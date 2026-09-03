import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  base64ToBytes,
  bytesToBase64,
  decodeBase64Utf8,
  encodeBase64Utf8,
} from "./base64";

describe("base64 round trips", () => {
  it("base64ToBytes(bytesToBase64(b)) === b, including buffers past the chunk size", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
        expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
      }),
      { examples: [[new Uint8Array(0x8000 * 2 + 7).map((_, i) => i % 251)]] }
    );
  });

  it("decodeBase64Utf8(encodeBase64Utf8(s)) === s for any well-formed Unicode string", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 60 }), (s) => {
        expect(decodeBase64Utf8(encodeBase64Utf8(s))).toBe(s);
      })
    );
  });

  it("encodeBase64Utf8 agrees with btoa on ASCII", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary-ascii", maxLength: 60 }), (s) => {
        expect(encodeBase64Utf8(s)).toBe(btoa(s));
        expect(decodeBase64Utf8(btoa(s))).toBe(s);
      })
    );
  });
});
