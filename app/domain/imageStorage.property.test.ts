/**
 * Property-based tests for the image quota: the total is order-independent and
 * additive, and the quota check is exactly "used + incoming > limit" — monotone
 * in both arguments, so an upload that fits never becomes rejected by using
 * less space.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { IMAGE_STORAGE_LIMIT_BYTES, totalImageBytes, exceedsImageQuota } from "./imageStorage";

const sizesArb = fc.array(fc.nat(IMAGE_STORAGE_LIMIT_BYTES), { maxLength: 30 });
const bytesArb = fc.nat(2 * IMAGE_STORAGE_LIMIT_BYTES);

describe("totalImageBytes", () => {
  it("is independent of order", () => {
    fc.assert(
      fc.property(sizesArb, (sizes) => {
        expect(totalImageBytes([...sizes].reverse())).toBe(totalImageBytes(sizes));
      })
    );
  });

  it("is additive over concatenation", () => {
    fc.assert(
      fc.property(sizesArb, sizesArb, (a, b) => {
        expect(totalImageBytes([...a, ...b])).toBe(totalImageBytes(a) + totalImageBytes(b));
      })
    );
  });
});

describe("exceedsImageQuota", () => {
  it("is exactly used + incoming > limit", () => {
    fc.assert(
      fc.property(bytesArb, bytesArb, (used, incoming) => {
        expect(exceedsImageQuota(used, incoming)).toBe(used + incoming > IMAGE_STORAGE_LIMIT_BYTES);
      })
    );
  });

  it("is monotone: a smaller upload is never rejected when a larger one fits", () => {
    fc.assert(
      fc.property(bytesArb, bytesArb, bytesArb, (used, a, b) => {
        const [small, large] = a <= b ? [a, b] : [b, a];
        if (!exceedsImageQuota(used, large)) expect(exceedsImageQuota(used, small)).toBe(false);
      })
    );
  });
});
