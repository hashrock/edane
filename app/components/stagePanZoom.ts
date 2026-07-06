/**
 * Binds wheel/trackpad pan-zoom to a Konva stage. One call replaces the old
 * inline `stage.on("wheel")` zoom handler in both the editor and the viewer:
 *
 *   - mouse wheel                 → stepped zoom at the pointer (unchanged)
 *   - trackpad 2-finger scroll    → pan
 *   - trackpad pinch (ctrl+wheel) → smooth zoom at the pointer
 *   - Safari pinch (GestureEvent) → smooth zoom at the pointer
 *
 * All gesture recognition and transform math lives in lib/panZoom (pure,
 * unit-tested); this module only moves values between DOM events and the
 * stage, then reports via `onTransform` so the caller can redraw.
 *
 * Returns a detach function. The Konva listeners die with stage.destroy(),
 * but the Safari gesture listeners sit on the container element — which
 * outlives the stage — so callers must invoke the detach in their cleanup.
 */

import {
  createWheelGestureRecognizer,
  panBy,
  zoomAt,
} from "../lib/panZoom";
import type { Vec, ViewTransform } from "../lib/viewport";

/** The slice of Konva.Stage we touch (konva is loaded dynamically). */
interface StageLike {
  x(): number;
  y(): number;
  scaleX(): number;
  scale(s: { x: number; y: number }): void;
  position(p: { x: number; y: number }): void;
  getPointerPosition(): Vec | null;
  container(): HTMLDivElement;
  on(evtStr: string, handler: (e: any) => void): void;
}

export function attachStagePanZoom(
  stage: StageLike,
  onTransform: () => void
): () => void {
  const recognize = createWheelGestureRecognizer();

  const current = (): ViewTransform => ({
    scale: stage.scaleX(),
    offsetX: stage.x(),
    offsetY: stage.y(),
  });
  const apply = (t: ViewTransform) => {
    stage.scale({ x: t.scale, y: t.scale });
    stage.position({ x: t.offsetX, y: t.offsetY });
    onTransform();
  };

  stage.on("wheel", (e: any) => {
    e.evt.preventDefault();
    const action = recognize({
      deltaX: e.evt.deltaX,
      deltaY: e.evt.deltaY,
      deltaMode: e.evt.deltaMode,
      ctrlKey: e.evt.ctrlKey,
      timeStamp: e.evt.timeStamp,
      wheelDeltaY: e.evt.wheelDeltaY,
    });
    if (action.type === "pan") {
      apply(panBy(current(), action.dx, action.dy));
      return;
    }
    const pointer = stage.getPointerPosition();
    if (!pointer) return;
    apply(zoomAt(current(), pointer, action.factor));
  });

  // Safari reports trackpad pinch as proprietary GestureEvents instead of
  // ctrl+wheel. `e.scale` is cumulative from gesturestart, so each change is
  // applied against the transform captured at the start. The listeners are
  // harmless no-ops in other browsers (the events simply never fire).
  const container = stage.container();
  let pinch: { base: ViewTransform; anchor: Vec; startScale: number } | null =
    null;
  const onGestureStart = (e: any) => {
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    pinch = {
      base: current(),
      anchor: { x: e.clientX - rect.left, y: e.clientY - rect.top },
      startScale: e.scale,
    };
  };
  const onGestureChange = (e: any) => {
    e.preventDefault();
    if (!pinch) return;
    apply(zoomAt(pinch.base, pinch.anchor, e.scale / pinch.startScale));
  };
  const onGestureEnd = (e: any) => {
    e.preventDefault();
    pinch = null;
  };
  container.addEventListener("gesturestart", onGestureStart);
  container.addEventListener("gesturechange", onGestureChange);
  container.addEventListener("gestureend", onGestureEnd);

  return () => {
    container.removeEventListener("gesturestart", onGestureStart);
    container.removeEventListener("gesturechange", onGestureChange);
    container.removeEventListener("gestureend", onGestureEnd);
  };
}
