import { describe, it, expect } from "vitest";
import { nodeBoxWidth, nodeBoxHeight } from "./measureText";
import {
  nodeRect,
  rectCenter,
  worldToScreen,
  screenToWorld,
  worldViewport,
  expandRect,
  rectsIntersect,
  offsetToAnchor,
  centerOffset,
  ensureVisibleOffset,
  type ViewTransform,
} from "./viewport";

const T = (scale: number, offsetX: number, offsetY: number): ViewTransform => ({
  scale,
  offsetX,
  offsetY,
});

describe("nodeRect", () => {
  it("derives the world box from a laid-out node (y is the centre)", () => {
    // width 60 → box 100 (floored), height 20 → box 32 (floored). y=250 centre.
    const r = nodeRect({ x: 300, y: 250, width: 60, height: 20 }, false);
    expect(r).toEqual({
      x: 300,
      y: 250 - nodeBoxHeight(20) / 2,
      width: nodeBoxWidth(60, false),
      height: nodeBoxHeight(20),
    });
  });

  it("uses the wider root floor for the root", () => {
    const child = nodeRect({ x: 0, y: 0, width: 10, height: 10 }, false);
    const root = nodeRect({ x: 0, y: 0, width: 10, height: 10 }, true);
    expect(root.width).toBeGreaterThanOrEqual(child.width);
  });
});

describe("world ↔ screen", () => {
  it("worldToScreen applies scale then offset", () => {
    expect(worldToScreen({ x: 100, y: 300 }, T(2, 50, -20))).toEqual({
      x: 250,
      y: 580,
    });
  });

  it("screenToWorld inverts worldToScreen", () => {
    const t = T(1.5, 40, 90);
    const p = { x: 123, y: -45 };
    const round = screenToWorld(worldToScreen(p, t), t);
    expect(round.x).toBeCloseTo(p.x, 9);
    expect(round.y).toBeCloseTo(p.y, 9);
  });

  it("rectCenter returns the middle of a rect", () => {
    expect(rectCenter({ x: 10, y: 20, width: 100, height: 40 })).toEqual({
      x: 60,
      y: 40,
    });
  });
});

describe("worldViewport", () => {
  it("maps the screen box to world units at scale 1", () => {
    const v = worldViewport(T(1, 0, 0), { width: 800, height: 600 });
    expect(v).toEqual({ x: 0, y: 0, width: 800, height: 600 });
  });

  it("accounts for pan and zoom", () => {
    // Stage panned by (100, 50) at 2×: world origin is (-50, -25), and the
    // 800×600 screen spans 400×300 world units.
    const v = worldViewport(T(2, 100, 50), { width: 800, height: 600 });
    expect(v.x).toBeCloseTo(-50, 9);
    expect(v.y).toBeCloseTo(-25, 9);
    expect(v.width).toBeCloseTo(400, 9);
    expect(v.height).toBeCloseTo(300, 9);
  });

  it("its corners round-trip through worldToScreen to (0,0) and (W,H)", () => {
    const t = T(1.25, -30, 15);
    const screen = { width: 640, height: 480 };
    const v = worldViewport(t, screen);
    const tl = worldToScreen({ x: v.x, y: v.y }, t);
    const br = worldToScreen({ x: v.x + v.width, y: v.y + v.height }, t);
    expect(tl.x).toBeCloseTo(0, 9);
    expect(tl.y).toBeCloseTo(0, 9);
    expect(br.x).toBeCloseTo(screen.width, 9);
    expect(br.y).toBeCloseTo(screen.height, 9);
  });
});

describe("rect helpers", () => {
  it("expandRect grows outward symmetrically", () => {
    expect(expandRect({ x: 10, y: 10, width: 20, height: 20 }, 5, 3)).toEqual({
      x: 5,
      y: 7,
      width: 30,
      height: 26,
    });
  });

  it("rectsIntersect detects overlap and separation", () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    expect(rectsIntersect(a, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
    expect(rectsIntersect(a, { x: 20, y: 0, width: 5, height: 5 })).toBe(false);
  });
});

describe("centering", () => {
  it("offsetToAnchor lands the world point on the anchor", () => {
    const t = { scale: 2, ...offsetToAnchor({ x: 100, y: 300 }, 2, { x: 400, y: 280 }) };
    const s = worldToScreen({ x: 100, y: 300 }, t);
    expect(s.x).toBeCloseTo(400, 9);
    expect(s.y).toBeCloseTo(280, 9);
  });

  it("centerOffset puts the point at the viewport centre", () => {
    const screen = { width: 800, height: 560 };
    const world = { x: 150, y: 300 };
    const off = centerOffset(world, 1, screen);
    const s = worldToScreen({ x: world.x, y: world.y }, { scale: 1, ...off });
    expect(s.x).toBeCloseTo(screen.width / 2, 9);
    expect(s.y).toBeCloseTo(screen.height / 2, 9);
  });

  it("centering a node's box centre works through nodeRect + rectCenter", () => {
    const screen = { width: 800, height: 560 };
    const node = { x: 100, y: 300, width: 60, height: 20 };
    const c = rectCenter(nodeRect(node, true));
    const off = centerOffset(c, 1, screen);
    const s = worldToScreen(c, { scale: 1, ...off });
    expect(s.x).toBeCloseTo(400, 9);
    expect(s.y).toBeCloseTo(280, 9);
  });
});

describe("ensureVisibleOffset", () => {
  const screen = { width: 800, height: 600 };
  const padding = 50;

  it("does not move when the target is already inside the padded viewport", () => {
    const t = T(1, 0, 0);
    const r = { x: 100, y: 100, width: 200, height: 32 };
    const out = ensureVisibleOffset(r, t, screen, padding);
    expect(out.changed).toBe(false);
    expect(out.offsetX).toBe(0);
    expect(out.offsetY).toBe(0);
  });

  it("pans left when the target sticks out past the right edge", () => {
    const t = T(1, 0, 0);
    const r = { x: 900, y: 100, width: 200, height: 32 };
    const out = ensureVisibleOffset(r, t, screen, padding);
    expect(out.changed).toBe(true);
    // After applying, the target's right edge sits on the padded boundary.
    const right = (r.x + r.width) * t.scale + out.offsetX;
    expect(right).toBeCloseTo(screen.width - padding, 9);
  });

  it("pans down when the target sticks out above the top edge", () => {
    const t = T(1, 0, 0);
    const r = { x: 100, y: -80, width: 200, height: 32 };
    const out = ensureVisibleOffset(r, t, screen, padding);
    expect(out.changed).toBe(true);
    const top = r.y * t.scale + out.offsetY;
    expect(top).toBeCloseTo(padding, 9);
  });

  it("honours scale when computing the pan", () => {
    const t = T(2, 0, 0);
    const r = { x: 500, y: 10, width: 100, height: 20 };
    const out = ensureVisibleOffset(r, t, screen, padding);
    // At 2×, the box right edge is at 1200px screen → must pan left into view.
    expect(out.changed).toBe(true);
    const right = (r.x + r.width) * t.scale + out.offsetX;
    expect(right).toBeCloseTo(screen.width - padding, 9);
  });
});
