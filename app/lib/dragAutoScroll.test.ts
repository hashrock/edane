import { describe, it, expect } from "vitest";
import {
  edgeScrollVelocity,
  EDGE_SCROLL_MARGIN,
  EDGE_SCROLL_MIN_SPEED,
  EDGE_SCROLL_MAX_SPEED,
} from "./dragAutoScroll";

const SCREEN = { width: 800, height: 600 };

describe("edgeScrollVelocity", () => {
  it("is still in the middle of the viewport", () => {
    expect(edgeScrollVelocity({ x: 400, y: 300 }, SCREEN)).toEqual({
      x: 0,
      y: 0,
    });
  });

  it("is still exactly at the band's inner boundary", () => {
    // The band is [0, MARGIN) — the boundary itself must not creep, or the
    // whole viewport minus a strip would scroll.
    const v = edgeScrollVelocity(
      { x: EDGE_SCROLL_MARGIN, y: SCREEN.height - EDGE_SCROLL_MARGIN },
      SCREEN
    );
    expect(v).toEqual({ x: 0, y: 0 });
  });

  it("pans the content right (revealing the left) near the left edge", () => {
    const v = edgeScrollVelocity({ x: 10, y: 300 }, SCREEN);
    expect(v.x).toBeGreaterThan(0);
    expect(v.y).toBe(0);
  });

  it("pans the content left (revealing the right) near the right edge", () => {
    const v = edgeScrollVelocity({ x: SCREEN.width - 10, y: 300 }, SCREEN);
    expect(v.x).toBeLessThan(0);
    expect(v.y).toBe(0);
  });

  it("pans vertically near the top and bottom edges", () => {
    expect(edgeScrollVelocity({ x: 400, y: 5 }, SCREEN).y).toBeGreaterThan(0);
    expect(
      edgeScrollVelocity({ x: 400, y: SCREEN.height - 5 }, SCREEN).y
    ).toBeLessThan(0);
  });

  it("scrolls diagonally in a corner", () => {
    const v = edgeScrollVelocity({ x: 4, y: 4 }, SCREEN);
    expect(v.x).toBeGreaterThan(0);
    expect(v.y).toBeGreaterThan(0);
  });

  it("speeds up as the pointer nears the edge", () => {
    const outer = edgeScrollVelocity({ x: EDGE_SCROLL_MARGIN - 4, y: 300 }, SCREEN);
    const middle = edgeScrollVelocity({ x: EDGE_SCROLL_MARGIN / 2, y: 300 }, SCREEN);
    const inner = edgeScrollVelocity({ x: 2, y: 300 }, SCREEN);
    expect(outer.x).toBeLessThan(middle.x);
    expect(middle.x).toBeLessThan(inner.x);
  });

  it("starts at the minimum speed and tops out at the maximum", () => {
    // Just inside the band: at least the floor, so entering is never a dead zone.
    const entering = edgeScrollVelocity(
      { x: EDGE_SCROLL_MARGIN - 0.001, y: 300 },
      SCREEN
    );
    expect(entering.x).toBeGreaterThanOrEqual(EDGE_SCROLL_MIN_SPEED);
    expect(entering.x).toBeLessThan(EDGE_SCROLL_MIN_SPEED + 1);

    expect(edgeScrollVelocity({ x: 0, y: 300 }, SCREEN).x).toBeCloseTo(
      EDGE_SCROLL_MAX_SPEED
    );
  });

  it("clamps past the edge instead of accelerating without bound", () => {
    // Pointer dragged well outside the canvas.
    const v = edgeScrollVelocity({ x: -500, y: SCREEN.height + 500 }, SCREEN);
    expect(v.x).toBeCloseTo(EDGE_SCROLL_MAX_SPEED);
    expect(v.y).toBeCloseTo(-EDGE_SCROLL_MAX_SPEED);
  });

  it("splits a viewport narrower than two bands at its centre", () => {
    // 100px wide with a 72px margin: the bands would overlap, so each gets 50px
    // and the exact centre stays still (no direction gets to win by ordering).
    const narrow = { width: 100, height: 600 };
    expect(edgeScrollVelocity({ x: 50, y: 300 }, narrow).x).toBe(0);
    expect(edgeScrollVelocity({ x: 49, y: 300 }, narrow).x).toBeGreaterThan(0);
    expect(edgeScrollVelocity({ x: 51, y: 300 }, narrow).x).toBeLessThan(0);
  });

  it("never scrolls in a zero-sized viewport", () => {
    expect(edgeScrollVelocity({ x: 0, y: 0 }, { width: 0, height: 0 })).toEqual({
      x: 0,
      y: 0,
    });
  });

  it("honours overridden margin and speeds", () => {
    const v = edgeScrollVelocity({ x: 5, y: 300 }, SCREEN, {
      margin: 200,
      minSpeed: 10,
      maxSpeed: 20,
    });
    // Deep in a 200px band, so close to the (overridden) maximum.
    expect(v.x).toBeGreaterThan(19);
    expect(v.x).toBeLessThanOrEqual(20);
    // Outside the default band but inside the overridden one.
    expect(edgeScrollVelocity({ x: 150, y: 300 }, SCREEN, { margin: 200 }).x)
      .toBeGreaterThan(0);
  });
});
