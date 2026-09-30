/**
 * Property-based tests for formatBytes: the printed number is the size in the
 * chosen unit, and never reaches the next unit's size (no "1024.0 KB").
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { formatBytes } from "./formatBytes";

const bytesArb = fc.integer({ min: 0, max: 10 * 1024 ** 3 });

const UNITS = {
  B: { scale: 1, tolerance: 0 },
  KB: { scale: 1024, tolerance: 0.05 },
  MB: { scale: 1024 ** 2, tolerance: 0.005 },
} as const;

describe("formatBytes", () => {
  it("prints the size in the chosen unit, within rounding", () => {
    fc.assert(
      fc.property(bytesArb, (bytes) => {
        const [, num, unit] = formatBytes(bytes).match(/^([\d.]+) (B|KB|MB)$/)!;
        const { scale, tolerance } = UNITS[unit as keyof typeof UNITS];
        expect(Math.abs(Number(num) - bytes / scale)).toBeLessThanOrEqual(tolerance + 1e-9);
      })
    );
  });

  it("never prints a value of 1024 or more in B / KB", () => {
    fc.assert(
      fc.property(bytesArb, (bytes) => {
        const [, num, unit] = formatBytes(bytes).match(/^([\d.]+) (B|KB|MB)$/)!;
        if (unit !== "MB") expect(Number(num)).toBeLessThan(1024);
      })
    );
  });

  it("rolls over at the KB → MB boundary", () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe("1.00 MB");
  });
});
