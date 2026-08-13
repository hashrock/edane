import { describe, it, expect } from "vitest";
import { IMAGE_STORAGE_LIMIT_BYTES, totalImageBytes, exceedsImageQuota } from "./imageStorage";

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
