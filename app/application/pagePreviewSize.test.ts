import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { memoryStorage } from "./browserStorage";
import {
  DEFAULT_PREVIEW_SCALE,
  MAX_PREVIEW_SCALE,
  MIN_PREVIEW_SCALE,
  PREVIEW_SCALE_KEY,
  clampPreviewScale,
  loadPreviewScale,
  resizedPreviewScale,
  savePreviewScale,
  type PreviewResizeEdge,
} from "./pagePreviewSize";

const WIDE = 4000;

describe("page preview size", () => {
  it("drags each edge: left widens leftwards, bottom grows downwards, the corner follows the larger move", () => {
    expect(resizedPreviewScale("left", 0.25, -64, 0, WIDE)).toBeCloseTo(0.3);
    expect(resizedPreviewScale("left", 0.25, 0, 500, WIDE)).toBeCloseTo(0.25);
    expect(resizedPreviewScale("bottom", 0.3, 0, -36, WIDE)).toBeCloseTo(0.25);
    expect(resizedPreviewScale("bottom", 0.25, -500, 0, WIDE)).toBeCloseTo(0.25);
    expect(resizedPreviewScale("corner", 0.25, -64, 9, WIDE)).toBeCloseTo(0.3);
    expect(resizedPreviewScale("corner", 0.25, -4, 36, WIDE)).toBeCloseTo(0.3);
  });

  it("stays within the range and the viewport", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<PreviewResizeEdge>("left", "bottom", "corner"),
        fc.double({ min: MIN_PREVIEW_SCALE, max: MAX_PREVIEW_SCALE, noNaN: true }),
        fc.integer({ min: -5000, max: 5000 }),
        fc.integer({ min: -5000, max: 5000 }),
        fc.integer({ min: 0, max: 5000 }),
        (edge, start, dx, dy, vw) => {
          const s = resizedPreviewScale(edge, start, dx, dy, vw);
          expect(s).toBeGreaterThanOrEqual(MIN_PREVIEW_SCALE);
          expect(s).toBeLessThanOrEqual(MAX_PREVIEW_SCALE);
          if (s > MIN_PREVIEW_SCALE) expect(s * 1280).toBeLessThanOrEqual(vw - 48 + 1e-9);
        }
      )
    );
  });

  it("load(save(s)) round-trips, and garbage or nothing falls back to the default", () => {
    const s = memoryStorage();
    expect(loadPreviewScale(WIDE, s)).toBe(DEFAULT_PREVIEW_SCALE);
    savePreviewScale(0.4, s);
    expect(loadPreviewScale(WIDE, s)).toBe(0.4);
    // Clamped to the viewport it opens in.
    expect(loadPreviewScale(1280 * 0.2 + 48, s)).toBeCloseTo(0.2);
    for (const raw of ["", "abc", "-1", "0", "NaN", "Infinity"])
      expect(loadPreviewScale(WIDE, memoryStorage({ [PREVIEW_SCALE_KEY]: raw }))).toBe(DEFAULT_PREVIEW_SCALE);
    expect(clampPreviewScale(9, WIDE)).toBe(MAX_PREVIEW_SCALE);
  });
});
