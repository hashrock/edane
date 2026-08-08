/**
 * Edge auto-scroll: how fast the view should pan while a drag is parked near a
 * viewport edge.
 *
 * Dropping a node outside the visible area used to be impossible — you had to
 * release, pan, and pick the branch up again. Holding the pointer in a band
 * along any edge now pans the stage that way for as long as the drag lasts, so
 * a branch can be carried anywhere in one gesture.
 *
 * The band is a ramp, not a switch: at the band's inner boundary the view
 * creeps (fine positioning next to an off-screen neighbour), at the edge itself
 * it races. Speed is in *screen* px/s, so it feels identical at every zoom
 * level — the same as every other pan in the app, which is why the result is a
 * delta for {@link panBy} rather than a world-space offset.
 *
 * Pure (no Konva/DOM/time) so the ramp is unit-testable in node; the caller
 * supplies the frame delta and applies the transform.
 */

import type { Size, Vec } from "./viewport";

/** Width of the hot band along each viewport edge (screen px). */
export const EDGE_SCROLL_MARGIN = 72;

/**
 * Speed the instant the pointer crosses into the band (screen px/s). A floor
 * rather than 0 so entering the band always produces visible motion — a ramp
 * starting at zero reads as a dead zone.
 */
export const EDGE_SCROLL_MIN_SPEED = 80;

/** Speed at (or past) the very edge (screen px/s). */
export const EDGE_SCROLL_MAX_SPEED = 1400;

export interface EdgeScrollOptions {
  margin?: number;
  minSpeed?: number;
  maxSpeed?: number;
}

/**
 * Pan velocity (screen px/s) for a pointer at `pointer` in a viewport of
 * `screen` size, as a delta to add to the stage offset — i.e. it feeds
 * `panBy(t, v.x * dt, v.y * dt)`.
 *
 * Positive x means the content slides right, revealing what lies off the left
 * edge, which is what a pointer held against the *left* edge asks for. Both
 * components are 0 whenever the pointer sits outside every band, so the caller
 * can treat `{x: 0, y: 0}` as "nothing to do this frame".
 *
 * A pointer past the edge (negative coordinate, or beyond width/height) is
 * clamped to the maximum rather than extrapolated — a drag that leaves the
 * canvas shouldn't accelerate without bound.
 */
export function edgeScrollVelocity(
  pointer: Vec,
  screen: Size,
  opts: EdgeScrollOptions = {}
): Vec {
  const margin = opts.margin ?? EDGE_SCROLL_MARGIN;
  const minSpeed = opts.minSpeed ?? EDGE_SCROLL_MIN_SPEED;
  const maxSpeed = opts.maxSpeed ?? EDGE_SCROLL_MAX_SPEED;
  return {
    x: axisVelocity(pointer.x, screen.width, margin, minSpeed, maxSpeed),
    y: axisVelocity(pointer.y, screen.height, margin, minSpeed, maxSpeed),
  };
}

/** One axis of {@link edgeScrollVelocity}. */
function axisVelocity(
  pos: number,
  size: number,
  margin: number,
  minSpeed: number,
  maxSpeed: number
): number {
  // The two bands must not overlap: on a viewport narrower than 2*margin they
  // meet at the centre instead of fighting over the middle (where both would
  // otherwise claim the pointer and the later test would silently win).
  const band = Math.min(margin, size / 2);
  if (band <= 0) return 0;

  // How far *into* each band the pointer has travelled (<= 0 = outside it).
  const intoStart = band - pos;
  const intoEnd = pos - (size - band);
  if (intoStart > 0) return speedAt(intoStart / band, minSpeed, maxSpeed);
  if (intoEnd > 0) return -speedAt(intoEnd / band, minSpeed, maxSpeed);
  return 0;
}

/**
 * The ramp itself: `depth` is 0 at the band's inner boundary and 1 at the edge.
 * Squared so the slow end of the band is generous — that's the half you steer
 * with, while the last few pixels are a deliberate "get me across the map".
 */
function speedAt(depth: number, minSpeed: number, maxSpeed: number): number {
  const t = Math.min(1, depth);
  return minSpeed + (maxSpeed - minSpeed) * t * t;
}
