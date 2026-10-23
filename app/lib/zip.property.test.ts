import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { createZip, crc32 } from "./zip";
import { readZip } from "./zip.testHelpers";

describe("createZip", () => {
  it("crc32 matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("round-trips any entries (names and bytes, in order)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ name: fc.string({ minLength: 1, unit: "grapheme" }), data: fc.uint8Array() }), { maxLength: 8 }),
        (entries) => {
          expect(readZip(createZip(entries))).toEqual(entries);
        }
      )
    );
  });

  it("encodes string data as UTF-8", () => {
    const [entry] = readZip(createZip([{ name: "ノート.md", data: "見出し" }]));
    expect(entry.name).toBe("ノート.md");
    expect(new TextDecoder().decode(entry.data)).toBe("見出し");
  });
});
