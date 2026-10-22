import { describe, it, expect } from "vitest";
import {
  IMAGE_STORAGE_LIMIT_BYTES,
  totalImageBytes,
  exceedsImageQuota,
  sniffImageType,
  imageResponseHeaders,
} from "./imageStorage";

describe("totalImageBytes", () => {
  it("sums the given sizes", () => {
    expect(totalImageBytes([100, 200, 300])).toBe(600);
  });

  it("returns 0 for an empty list", () => {
    expect(totalImageBytes([])).toBe(0);
  });
});

describe("exceedsImageQuota", () => {
  it("is false when used + incoming is under the limit", () => {
    expect(exceedsImageQuota(0, IMAGE_STORAGE_LIMIT_BYTES - 1)).toBe(false);
  });

  it("is false exactly at the limit", () => {
    expect(exceedsImageQuota(0, IMAGE_STORAGE_LIMIT_BYTES)).toBe(false);
  });

  it("is true one byte over the limit", () => {
    expect(exceedsImageQuota(0, IMAGE_STORAGE_LIMIT_BYTES + 1)).toBe(true);
  });

  it("accounts for already-used bytes", () => {
    expect(exceedsImageQuota(IMAGE_STORAGE_LIMIT_BYTES, 1)).toBe(true);
  });
});

describe("sniffImageType", () => {
  const bytes = (...parts: (number[] | string)[]) =>
    new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));

  it.each([
    ["image/png", bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0, 0])],
    ["image/jpeg", bytes([0xff, 0xd8, 0xff, 0xe0])],
    ["image/gif", bytes("GIF89a", [1, 0])],
    ["image/gif", bytes("GIF87a")],
    ["image/webp", bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 ")],
    ["image/avif", bytes([0, 0, 0, 0x20], "ftypavif")],
  ])("recognizes %s by its magic number", (type, b) => {
    expect(sniffImageType(b)).toBe(type);
  });

  it.each([
    ["SVG", bytes('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ["SVG with an XML prolog", bytes('<?xml version="1.0"?><svg/>')],
    ["HTML", bytes("<!doctype html><script>alert(1)</script>")],
    ["an empty file", bytes()],
    ["a truncated PNG header", bytes([0x89, 0x50, 0x4e])],
    ["RIFF that is not WebP", bytes("RIFF", [0, 0, 0, 0], "WAVE")],
  ])("refuses %s", (_, b) => {
    expect(sniffImageType(b)).toBeNull();
  });
});

describe("imageResponseHeaders", () => {
  it("serves an allowed type inline, without sniffing, sandboxed", () => {
    const h = imageResponseHeaders("image/png");
    expect(h["Content-Type"]).toBe("image/png");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Content-Security-Policy"]).toContain("sandbox");
    expect(h["Content-Security-Policy"]).toContain("default-src 'none'");
    expect(h["Content-Disposition"]).toBeUndefined();
  });

  it("sends a legacy SVG as a sandboxed attachment but keeps its type for <img>", () => {
    const h = imageResponseHeaders("image/svg+xml");
    expect(h["Content-Type"]).toBe("image/svg+xml");
    expect(h["Content-Disposition"]).toBe("attachment");
    expect(h["Content-Security-Policy"]).toContain("sandbox");
  });

  it.each(["text/html", "image/x,text/html", "image/svg+xml; charset=utf-8"])(
    "never echoes another stored type (%s)",
    (type) => {
      const h = imageResponseHeaders(type);
      expect(h["Content-Type"]).toBe("application/octet-stream");
      expect(h["Content-Disposition"]).toBe("attachment");
    }
  );
});
