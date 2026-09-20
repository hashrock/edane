/**
 * edgeScrollVelocity's ramp, as properties: zero outside the bands, a speed in
 * [min, max] inside them that only grows as the pointer nears the edge, with
 * the sign that reveals what lies beyond that edge (left/top edge → positive,
 * i.e. content slides right/down), and clamped past the edge.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  EDGE_SCROLL_MARGIN,
  EDGE_SCROLL_MAX_SPEED,
  EDGE_SCROLL_MIN_SPEED,
  edgeScrollVelocity,
} from "./dragAutoScroll";

const screenArb = fc.record({
  width: fc.integer({ min: 1, max: 2000 }),
  height: fc.integer({ min: 1, max: 2000 }),
});

describe("edgeScrollVelocity", () => {
  it("is zero outside the bands, otherwise bounded, signed toward the edge, and monotone in depth", () => {
    fc.assert(
      fc.property(
        screenArb,
        fc.integer({ min: -300, max: 2300 }),
        fc.integer({ min: -300, max: 2300 }),
        fc.nat({ max: 100 }),
        (screen, x, y, step) => {
          const v = edgeScrollVelocity({ x, y }, screen);
          for (const [pos, size, comp] of [
            [x, screen.width, v.x],
            [y, screen.height, v.y],
          ] as const) {
            const band = Math.min(EDGE_SCROLL_MARGIN, size / 2);
            const nearStart = pos < band;
            const nearEnd = pos > size - band;
            if (!nearStart && !nearEnd) {
              expect(comp).toBe(0);
              continue;
            }
            expect(Math.abs(comp)).toBeGreaterThanOrEqual(EDGE_SCROLL_MIN_SPEED);
            expect(Math.abs(comp)).toBeLessThanOrEqual(EDGE_SCROLL_MAX_SPEED);
            expect(Math.sign(comp)).toBe(nearStart ? 1 : -1);
          }
          // Moving `step` px further toward the left edge never slows down.
          if (x < Math.min(EDGE_SCROLL_MARGIN, screen.width / 2)) {
            const deeper = edgeScrollVelocity({ x: x - step, y }, screen);
            expect(deeper.x).toBeGreaterThanOrEqual(v.x);
          }
          // Past the edge it is clamped to the maximum, not extrapolated.
          if (x <= 0) expect(v.x).toBe(EDGE_SCROLL_MAX_SPEED);
        }
      )
    );
  });
});
