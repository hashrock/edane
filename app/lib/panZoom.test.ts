import { describe, it, expect } from "vitest";
import {
  createWheelGestureRecognizer,
  zoomAt,
  panBy,
  clampScale,
  MIN_SCALE,
  MAX_SCALE,
  WHEEL_ZOOM_STEP,
  PINCH_ZOOM_SPEED,
  GESTURE_BURST_MS,
  type WheelInput,
} from "./panZoom";
import type { ViewTransform } from "./viewport";

const T = (scale: number, offsetX: number, offsetY: number): ViewTransform => ({
  scale,
  offsetX,
  offsetY,
});

/** WheelInput factory: vertical-only pixel deltas by default. */
const wheel = (overrides: Partial<WheelInput>): WheelInput => ({
  deltaX: 0,
  deltaY: 0,
  deltaMode: 0,
  ctrlKey: false,
  timeStamp: 0,
  ...overrides,
});

describe("createWheelGestureRecognizer", () => {
  it("mouse wheel (±120 wheelDeltaY notches) zooms with the legacy step", () => {
    const recognize = createWheelGestureRecognizer();
    // Scroll down = zoom out, scroll up = zoom in — matches the old handler.
    expect(recognize(wheel({ deltaY: 100, wheelDeltaY: -120 }))).toEqual({
      type: "zoom",
      factor: 1 / WHEEL_ZOOM_STEP,
    });
    expect(
      recognize(wheel({ deltaY: -100, wheelDeltaY: 120, timeStamp: 50 }))
    ).toEqual({ type: "zoom", factor: WHEEL_ZOOM_STEP });
  });

  it("line-mode deltas (Firefox mouse) zoom", () => {
    const recognize = createWheelGestureRecognizer();
    expect(recognize(wheel({ deltaY: 3, deltaMode: 1 }))).toEqual({
      type: "zoom",
      factor: 1 / WHEEL_ZOOM_STEP,
    });
  });

  it("ambiguous first event defaults to mouse (zoom) — legacy behaviour wins", () => {
    const recognize = createWheelGestureRecognizer();
    // Integer vertical delta, no wheelDeltaY: could be either device.
    expect(recognize(wheel({ deltaY: 4 }))).toEqual({
      type: "zoom",
      factor: 1 / WHEEL_ZOOM_STEP,
    });
  });

  it("trackpad scroll (fractional deltas) pans, content following the fingers", () => {
    const recognize = createWheelGestureRecognizer();
    expect(recognize(wheel({ deltaX: 2.5, deltaY: -7.5 }))).toEqual({
      type: "pan",
      dx: -2.5,
      dy: 7.5,
    });
  });

  it("trackpad scroll (non-120-multiple wheelDeltaY) pans", () => {
    const recognize = createWheelGestureRecognizer();
    // Integer deltaY, but wheelDeltaY = -3 * deltaY = -12 betrays the trackpad.
    expect(recognize(wheel({ deltaY: 4, wheelDeltaY: -12 }))).toEqual({
      type: "pan",
      dx: -0,
      dy: -4,
    });
  });

  it("horizontal-only deltas pan (trackpad or shift+wheel)", () => {
    const recognize = createWheelGestureRecognizer();
    expect(recognize(wheel({ deltaX: 10 }))).toEqual({
      type: "pan",
      dx: -10,
      dy: -0,
    });
  });

  it("ambiguous events inside a trackpad burst keep panning", () => {
    const recognize = createWheelGestureRecognizer();
    recognize(wheel({ deltaY: 3.5, timeStamp: 0 })); // trackpad
    // deltaY 40 → wheelDeltaY -120: alone it would look like a mouse notch.
    const mid = recognize(wheel({ deltaY: 40, wheelDeltaY: -120, timeStamp: 16 }));
    expect(mid.type).toBe("pan");
  });

  it("after the burst window the same ambiguous event zooms again", () => {
    const recognize = createWheelGestureRecognizer();
    recognize(wheel({ deltaY: 3.5, timeStamp: 0 })); // trackpad
    const later = recognize(
      wheel({ deltaY: 40, wheelDeltaY: -120, timeStamp: GESTURE_BURST_MS + 1 })
    );
    expect(later.type).toBe("zoom");
  });

  it("pinch (ctrl + trackpad deltas) zooms smoothly and exponentially", () => {
    const recognize = createWheelGestureRecognizer();
    const action = recognize(wheel({ deltaY: -5.5, ctrlKey: true }));
    expect(action).toEqual({
      type: "zoom",
      factor: Math.exp(5.5 * PINCH_ZOOM_SPEED),
    });
  });

  it("ctrl + mouse wheel keeps the stepped zoom", () => {
    const recognize = createWheelGestureRecognizer();
    const action = recognize(
      wheel({ deltaY: 100, wheelDeltaY: -120, ctrlKey: true })
    );
    expect(action).toEqual({ type: "zoom", factor: 1 / WHEEL_ZOOM_STEP });
  });
});

describe("zoomAt", () => {
  it("keeps the world point under the anchor fixed on screen", () => {
    const t = T(1, 100, 50);
    const anchor = { x: 300, y: 200 };
    const out = zoomAt(t, anchor, 2);
    expect(out.scale).toBe(2);
    // World point under the anchor before: ((300-100)/1, (200-50)/1) = (200, 150).
    // After: 200*2 + offsetX must still be 300.
    expect(200 * out.scale + out.offsetX).toBeCloseTo(300);
    expect(150 * out.scale + out.offsetY).toBeCloseTo(200);
  });

  it("clamps the scale to [MIN_SCALE, MAX_SCALE]", () => {
    expect(zoomAt(T(2.9, 0, 0), { x: 0, y: 0 }, 10).scale).toBe(MAX_SCALE);
    expect(zoomAt(T(0.25, 0, 0), { x: 0, y: 0 }, 0.01).scale).toBe(MIN_SCALE);
  });

  it("matches the legacy wheel-zoom math for one step", () => {
    // Reproduces the old inline handler on the same inputs.
    const oldScale = 1.3;
    const pointer = { x: 411, y: 253 };
    const stagePos = { x: -37, y: 90 };
    const mousePointTo = {
      x: (pointer.x - stagePos.x) / oldScale,
      y: (pointer.y - stagePos.y) / oldScale,
    };
    const limitedScale = Math.max(0.2, Math.min(3, oldScale * 1.05));
    const legacy = {
      scale: limitedScale,
      offsetX: pointer.x - mousePointTo.x * limitedScale,
      offsetY: pointer.y - mousePointTo.y * limitedScale,
    };
    const out = zoomAt(
      T(oldScale, stagePos.x, stagePos.y),
      pointer,
      WHEEL_ZOOM_STEP
    );
    expect(out.scale).toBeCloseTo(legacy.scale);
    expect(out.offsetX).toBeCloseTo(legacy.offsetX);
    expect(out.offsetY).toBeCloseTo(legacy.offsetY);
  });
});

describe("panBy", () => {
  it("translates the offset and preserves the scale", () => {
    expect(panBy(T(1.5, 10, 20), -3, 7)).toEqual(T(1.5, 7, 27));
  });
});

describe("clampScale", () => {
  it("bounds the scale", () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE);
    expect(clampScale(1)).toBe(1);
    expect(clampScale(99)).toBe(MAX_SCALE);
  });
});
