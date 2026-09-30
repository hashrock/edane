/**
 * Property-based tests for formatBytes: the printed number never reaches the
 * next unit's size (no "1024.0 KB"), and the number is the size in that unit.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { formatBytes } from "./formatBytes";

const bytesArb = fc.integer({ min: 0, max: 10 * 1024 ** 3 });

describe("formatBytes", () => {
  it("never prints a value of 1024 or more in B / KB", () => {
    fc.assert(
      fc.property(bytesArb, (bytes) => {
        const m = formatBytes(bytes).match(/^([\d.]+) (B|KB|MB)$/);
        expect(m).not.toBeNull();
        if (m![2] !== "MB") expect(Number(m![1])).toBeLessThan(1024);
      })
    );
  });

  it("prints the size in the chosen unit, within rounding", () => {
    const scale = { B: 1, KB: 1024, MB: 1024 ** 2 } as const;
    fc.assert(
      fc.property(bytesArb, (bytes) => {
        const [num, unit] = formatBytes(bytes).split(" ");
        const tolerance = unit === "B" ? 0 : unit === "KB" ? 0.05 : 0.005;
        expect(Math.abs(Number(num) - bytes / scale[unit as keyof typeof scale])).toBeLessThanOrEqual(
          tolerance + 1e-9
        );
      })
    );
  });

  it("rolls over at the KB → MB boundary", () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe("1.00 MB");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });
});
