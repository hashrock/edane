/**
 * Viewport geometry: the pure "size calculation" layer shared by every part of
 * the canvas that has to reason about where a node sits on screen — auto-scroll,
 * centre-on-open, viewport culling, the IME/URL input placement, hit-testing and
 * drag preview all used to re-derive this math inline. Centralising it here keeps
 * a single source of truth for:
 *
 *   - a node's world-space box        → {@link nodeRect}
 *   - world ↔ screen conversion       → {@link worldToScreen} / {@link screenToWorld}
 *   - the world rectangle currently visible → {@link worldViewport}
 *   - the stage offset that centres a point → {@link centerOffset}
 *   - the stage offset that scrolls a rect just into view → {@link ensureVisibleOffset}
 *
 * The Konva stage transform is `screen = world * scale + offset`. A
 * {@link ViewTransform} carries that `scale` and `offset` (the stage's x/y).
 *
 * No Konva / DOM dependency, so every function is unit-testable in node.
 */

import { nodeBoxWidth, nodeBoxHeight } from "./measureText";

export interface Vec {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Stage transform. `offset` is the stage's screen-space translation (Konva's
 * `stage.x()` / `stage.y()`); a world point maps to `world * scale + offset`.
 */
export interface ViewTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** Minimal laid-out node shape needed to derive a box (from treeLayout). */
export interface PlacedNode {
  /** Box left edge (world). */
  x: number;
  /** Box vertical CENTRE (world). */
  y: number;
  /** Measured content width (px), pre-padding/floor. */
  width: number;
  /** Measured content height (px), pre-floor. */
  height: number;
}

/**
 * The world-space box of a laid-out node. `x` is the left edge and the node's
 * `y` is its vertical centre (as produced by the layout), so the returned rect's
 * top is `y - height/2`. Width/height apply the shared box floors + padding via
 * {@link nodeBoxWidth} / {@link nodeBoxHeight}, so the rect matches exactly what
 * the canvas draws.
 */
export function nodeRect(node: PlacedNode, isRoot: boolean): Rect {
  const width = nodeBoxWidth(node.width, isRoot);
  const height = nodeBoxHeight(node.height);
  return { x: node.x, y: node.y - height / 2, width, height };
}

/** Centre point of a rectangle. */
export function rectCenter(r: Rect): Vec {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** World point → screen point under a transform. */
export function worldToScreen(p: Vec, t: ViewTransform): Vec {
  return { x: p.x * t.scale + t.offsetX, y: p.y * t.scale + t.offsetY };
}

/** Screen point → world point under a transform (inverse of worldToScreen). */
export function screenToWorld(p: Vec, t: ViewTransform): Vec {
  return { x: (p.x - t.offsetX) / t.scale, y: (p.y - t.offsetY) / t.scale };
}

/**
 * The world-space rectangle currently visible for a stage of `screen` size under
 * `t`. Its top-left is `screenToWorld(0,0)` and its size is the screen size in
 * world units (screen / scale). Callers expand this by a margin for culling.
 */
export function worldViewport(t: ViewTransform, screen: Size): Rect {
  const topLeft = screenToWorld({ x: 0, y: 0 }, t);
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: screen.width / t.scale,
    height: screen.height / t.scale,
  };
}

/** Grow a rectangle outward by `dx` on the left/right and `dy` on top/bottom. */
export function expandRect(r: Rect, dx: number, dy: number): Rect {
  return {
    x: r.x - dx,
    y: r.y - dy,
    width: r.width + dx * 2,
    height: r.height + dy * 2,
  };
}

/** Do two rectangles overlap (touching edges count as overlapping)? */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x + a.width >= b.x &&
    a.x <= b.x + b.width &&
    a.y + a.height >= b.y &&
    a.y <= b.y + b.height
  );
}

/**
 * The stage offset that lands `world` at the given `anchor` screen point:
 * from `anchor = world * scale + offset` ⇒ `offset = anchor − world * scale`.
 */
export function offsetToAnchor(
  world: Vec,
  scale: number,
  anchor: Vec
): { offsetX: number; offsetY: number } {
  return {
    offsetX: anchor.x - world.x * scale,
    offsetY: anchor.y - world.y * scale,
  };
}

/** The stage offset that centres `world` in a viewport of size `screen`. */
export function centerOffset(
  world: Vec,
  scale: number,
  screen: Size
): { offsetX: number; offsetY: number } {
  return offsetToAnchor(world, scale, {
    x: screen.width / 2,
    y: screen.height / 2,
  });
}

/**
 * The stage offset that scrolls the world rectangle `target` just far enough to
 * sit fully inside the viewport, keeping a `padding` screen-space margin. Pans on
 * each axis independently and only when `target` sticks out on that side; a
 * `target` already within the padded viewport yields `changed: false` and the
 * current offset unchanged. When `target` is larger than the padded viewport on
 * an axis it is aligned to the near edge (its far edge may stay clipped).
 */
export function ensureVisibleOffset(
  target: Rect,
  t: ViewTransform,
  screen: Size,
  padding: number
): { offsetX: number; offsetY: number; changed: boolean } {
  const left = target.x * t.scale + t.offsetX;
  const top = target.y * t.scale + t.offsetY;
  const right = left + target.width * t.scale;
  const bottom = top + target.height * t.scale;

  let offsetX = t.offsetX;
  let offsetY = t.offsetY;

  if (left < padding) {
    offsetX = padding - target.x * t.scale;
  } else if (right > screen.width - padding) {
    offsetX = screen.width - padding - (target.x + target.width) * t.scale;
  }

  if (top < padding) {
    offsetY = padding - target.y * t.scale;
  } else if (bottom > screen.height - padding) {
    offsetY = screen.height - padding - (target.y + target.height) * t.scale;
  }

  return {
    offsetX,
    offsetY,
    changed: offsetX !== t.offsetX || offsetY !== t.offsetY,
  };
}
