/**
 * Wheel-gesture recognition + pan/zoom transform math for the canvas stage.
 *
 * A single DOM `wheel` event stream carries three distinct user intents:
 *
 *   - mouse wheel            → zoom (legacy behaviour, fixed 1.05 steps)
 *   - trackpad 2-finger scroll → pan (content follows the fingers)
 *   - trackpad pinch          → zoom (smooth, proportional to the pinch)
 *
 * Browsers don't label the source device, so {@link createWheelGestureRecognizer}
 * classifies each event with the standard heuristics (deltaMode, sub-pixel
 * deltas, the legacy `wheelDeltaY` 120-multiple convention) plus a short
 * "burst" memory: ambiguous events inside a continuous stream inherit the
 * classification of the event that started it, so a trackpad pan that happens
 * to pass through mouse-looking delta values doesn't flicker into a zoom.
 * When a gesture starts ambiguous we default to "mouse" — preserving the
 * pre-trackpad behaviour (wheel = zoom) is the safe fallback.
 *
 * The transform helpers ({@link zoomAt}, {@link panBy}) are pure functions on
 * {@link ViewTransform} so the whole module stays unit-testable in node, like
 * viewport.ts which it builds on.
 */

import {
  offsetToAnchor,
  screenToWorld,
  type Vec,
  type ViewTransform,
} from "./viewport";

/** Stage zoom bounds (shared by every code path that writes the scale). */
export const MIN_SCALE = 0.2;
export const MAX_SCALE = 3;

/** Legacy mouse-wheel zoom step (one wheel event = ×1.05 or ÷1.05). */
export const WHEEL_ZOOM_STEP = 1.05;

/**
 * Pinch zoom speed: scale factor is `exp(-deltaY * speed)`, so the zoom is
 * multiplicative in the finger travel — small continuous deltas produce a
 * smooth 1:1-feeling zoom rather than the chunky wheel steps.
 */
export const PINCH_ZOOM_SPEED = 0.01;

/**
 * Two wheel events closer than this are treated as one continuous gesture for
 * device classification (trackpad streams fire at frame rate, so this is
 * generous; a deliberate device switch takes far longer).
 */
export const GESTURE_BURST_MS = 300;

export function clampScale(scale: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
}

/** The subset of a DOM WheelEvent the recognizer needs (testable without DOM). */
export interface WheelInput {
  deltaX: number;
  deltaY: number;
  /** 0 = pixels, 1 = lines, 2 = pages (line/page deltas only come from wheels). */
  deltaMode: number;
  /** True for trackpad pinch (browsers synthesize ctrl+wheel) and real ctrl+wheel. */
  ctrlKey: boolean;
  /** Event timeStamp (ms) — drives the burst continuity window. */
  timeStamp: number;
  /**
   * Legacy WebKit property, when present: mice report multiples of ±120 per
   * notch; macOS trackpads report `-3 * deltaY` (rarely a 120 multiple).
   */
  wheelDeltaY?: number;
}

export type WheelAction =
  | { type: "pan"; dx: number; dy: number }
  | { type: "zoom"; factor: number };

type Device = "mouse" | "trackpad";

/**
 * Per-event device detection. Returns null when the event alone is ambiguous
 * (integer vertical-only deltas that could be either device) — the recognizer
 * then falls back to burst memory / the mouse default.
 */
function detectDevice(e: WheelInput): Device | null {
  // Line/page deltas only ever come from real wheels (e.g. Firefox mice).
  if (e.deltaMode !== 0) return "mouse";
  // Sub-pixel precision only comes from trackpads.
  if (!Number.isInteger(e.deltaX) || !Number.isInteger(e.deltaY)) {
    return "trackpad";
  }
  // Legacy wheelDeltaY: mouse notches are ±120 multiples; a trackpad reports
  // -3 * deltaY, which is a 120 multiple only when deltaY happens to be a
  // multiple of 40 (the burst memory covers those moments mid-stream).
  if (
    e.wheelDeltaY !== undefined &&
    e.wheelDeltaY !== 0 &&
    e.wheelDeltaY % 120 !== 0
  ) {
    return "trackpad";
  }
  // A horizontal component means a trackpad — or shift+wheel on a mouse, where
  // a horizontal pan is what the user wants anyway.
  if (e.deltaX !== 0) return "trackpad";
  return null;
}

/**
 * Creates a stateful classifier: WheelInput → the pan/zoom action to apply.
 * Stateful because ambiguous events inherit the device of the burst they
 * belong to (see module docs). One recognizer per stage.
 */
export function createWheelGestureRecognizer(): (e: WheelInput) => WheelAction {
  let lastDevice: Device = "mouse";
  let lastTime = -Infinity;

  return (e: WheelInput): WheelAction => {
    const detected = detectDevice(e);
    const inBurst = e.timeStamp - lastTime < GESTURE_BURST_MS;
    const device: Device = detected ?? (inBurst ? lastDevice : "mouse");
    lastDevice = device;
    lastTime = e.timeStamp;

    if (e.ctrlKey) {
      // Pinch (trackpad) zooms smoothly; ctrl+mouse-wheel keeps the classic
      // stepped zoom — same result the pre-ctrl-aware code produced.
      const factor =
        device === "trackpad"
          ? Math.exp(-e.deltaY * PINCH_ZOOM_SPEED)
          : stepZoomFactor(e.deltaY);
      return { type: "zoom", factor };
    }
    if (device === "trackpad") {
      // Negated so the content follows the fingers (macOS natural scrolling).
      return { type: "pan", dx: -e.deltaX, dy: -e.deltaY };
    }
    return { type: "zoom", factor: stepZoomFactor(e.deltaY) };
  };
}

/** Classic wheel zoom: scroll away = out, toward = in, one fixed step. */
function stepZoomFactor(deltaY: number): number {
  return deltaY > 0 ? 1 / WHEEL_ZOOM_STEP : WHEEL_ZOOM_STEP;
}

/**
 * Zoom by `factor` keeping the world point under `anchor` (screen coords)
 * fixed on screen. The resulting scale is clamped to [MIN_SCALE, MAX_SCALE].
 */
export function zoomAt(
  t: ViewTransform,
  anchor: Vec,
  factor: number
): ViewTransform {
  const scale = clampScale(t.scale * factor);
  const world = screenToWorld(anchor, t);
  const { offsetX, offsetY } = offsetToAnchor(world, scale, anchor);
  return { scale, offsetX, offsetY };
}

/** Translate the view by a screen-space delta. */
export function panBy(t: ViewTransform, dx: number, dy: number): ViewTransform {
  return { scale: t.scale, offsetX: t.offsetX + dx, offsetY: t.offsetY + dy };
}
