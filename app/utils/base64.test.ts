import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  bytesToBase64,
  decodeBase64Utf8,
  encodeBase64Utf8,
} from "./base64";

describe("encodeBase64Utf8", () => {
  it("round-trips non-Latin1 text that raw btoa() rejects", () => {
    const user = JSON.stringify({
      id: "1",
      email: "a@example.com",
      name: "山田太郎 🎉",
      avatarUrl: "https://example.com/a.png",
    });
    expect(() => btoa(user)).toThrow();
    expect(decodeBase64Utf8(encodeBase64Utf8(user))).toBe(user);
  });

  it("matches btoa/atob for ASCII, so existing sessions stay readable", () => {
    const ascii = '{"id":"1","name":"Taro"}';
    expect(encodeBase64Utf8(ascii)).toBe(btoa(ascii));
    expect(decodeBase64Utf8(btoa(ascii))).toBe(ascii);
  });
});

describe("bytesToBase64", () => {
  it("round-trips binary bytes", () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it("handles buffers larger than the chunk size without blowing the stack", () => {
    const bytes = new Uint8Array(0x8000 * 3 + 7).map((_, i) => i % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});
