/**
 * Property-based tests for the view transform algebra in viewport.ts and
 * panZoom.ts: screen↔world are inverses, zooming keeps the anchor's world
 * point under the cursor, panning shifts every screen point by the delta,
 * and ensureVisibleOffset actually brings a fitting target into view.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  ensureVisibleOffset,
  screenToWorld,
  worldToScreen,
  type Rect,
  type Vec,
  type ViewTransform,
} from "./viewport";
import { clampScale, MAX_SCALE, MIN_SCALE, panBy, zoomAt } from "./panZoom";

// Powers of two keep the arithmetic exact, so equalities below need no epsilon.
const scaleArb = fc.constantFrom(0.25, 0.5, 1, 2);
const coord = fc.integer({ min: -5000, max: 5000 });
const vecArb: fc.Arbitrary<Vec> = fc.record({ x: coord, y: coord });
const transformArb: fc.Arbitrary<ViewTransform> = fc.record({
  scale: scaleArb,
  offsetX: coord,
  offsetY: coord,
});
const expectVecClose = (a: Vec, b: Vec) => {
  expect(a.x).toBeCloseTo(b.x, 6);
  expect(a.y).toBeCloseTo(b.y, 6);
};

describe("viewport transforms", () => {
  it("screenToWorld ∘ worldToScreen = id", () => {
    fc.assert(
      fc.property(vecArb, transformArb, (p, t) => {
        expect(screenToWorld(worldToScreen(p, t), t)).toEqual(p);
        expect(worldToScreen(screenToWorld(p, t), t)).toEqual(p);
      })
    );
  });

  it("zoomAt keeps the world point under the anchor fixed and clamps the scale", () => {
    fc.assert(
      fc.property(
        transformArb,
        vecArb,
        fc.double({ min: 0.01, max: 100, noNaN: true }),
        (t, anchor, factor) => {
          const z = zoomAt(t, anchor, factor);
          expect(z.scale).toBeGreaterThanOrEqual(MIN_SCALE);
          expect(z.scale).toBeLessThanOrEqual(MAX_SCALE);
          expect(z.scale).toBe(clampScale(t.scale * factor));
          expectVecClose(screenToWorld(anchor, z), screenToWorld(anchor, t));
        }
      )
    );
  });

  it("panBy shifts every screen point by exactly the delta", () => {
    fc.assert(
      fc.property(transformArb, vecArb, coord, coord, (t, p, dx, dy) => {
        const before = worldToScreen(p, t);
        const after = worldToScreen(p, panBy(t, dx, dy));
        expect(after).toEqual({ x: before.x + dx, y: before.y + dy });
      })
    );
  });

  it("ensureVisibleOffset brings a fitting target inside the padded viewport, and reports changed iff it moved", () => {
    const rectArb: fc.Arbitrary<Rect> = fc.record({
      x: coord,
      y: coord,
      width: fc.integer({ min: 0, max: 600 }),
      height: fc.integer({ min: 0, max: 600 }),
    });
    fc.assert(
      fc.property(
        rectArb,
        transformArb,
        fc.record({ width: fc.integer({ min: 200, max: 2000 }), height: fc.integer({ min: 200, max: 2000 }) }),
        fc.integer({ min: 0, max: 50 }),
        (target, t, screen, padding) => {
          const r = ensureVisibleOffset(target, t, screen, padding);
          expect(r.changed).toBe(r.offsetX !== t.offsetX || r.offsetY !== t.offsetY);
          const next = { ...t, offsetX: r.offsetX, offsetY: r.offsetY };
          const tl = worldToScreen({ x: target.x, y: target.y }, next);
          const br = worldToScreen({ x: target.x + target.width, y: target.y + target.height }, next);
          if (target.width * t.scale <= screen.width - 2 * padding) {
            expect(tl.x).toBeGreaterThanOrEqual(padding);
            expect(br.x).toBeLessThanOrEqual(screen.width - padding);
          }
          if (target.height * t.scale <= screen.height - 2 * padding) {
            expect(tl.y).toBeGreaterThanOrEqual(padding);
            expect(br.y).toBeLessThanOrEqual(screen.height - padding);
          }
        }
      )
    );
  });
});
