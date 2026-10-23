/**
 * Application layer: the page preview's per-device size.
 *
 * The preview (PagePreview.tsx) lays the page out at 1280×720 and scales it
 * down, so its size is one number — the scale — and the 16:9 aspect ratio
 * holds by construction. Its edges drag to resize it; the size is remembered
 * per device (best effort — losing it just means the default size).
 */

import { defaultLocalStorage, type KeyValueStorage } from "./browserStorage";

/** The size the page is laid out at before scaling. */
export const PREVIEW_VIRTUAL_WIDTH = 1280;
export const PREVIEW_VIRTUAL_HEIGHT = 720;

export const PREVIEW_SCALE_KEY = "edane:page-preview-scale";
export const DEFAULT_PREVIEW_SCALE = 0.25;
export const MIN_PREVIEW_SCALE = 0.15;
export const MAX_PREVIEW_SCALE = 0.75;
/** Room left of the preview: it is anchored to the viewport's top-right corner. */
const VIEWPORT_MARGIN = 48;

/** Within the fixed range, and no wider than the viewport allows. */
export function clampPreviewScale(scale: number, viewportWidth: number): number {
  const viewportMax = (viewportWidth - VIEWPORT_MARGIN) / PREVIEW_VIRTUAL_WIDTH;
  return Math.max(MIN_PREVIEW_SCALE, Math.min(scale, MAX_PREVIEW_SCALE, viewportMax));
}

/**
 * Which edges a resize handle moves. The preview sits in the top-right
 * corner, so it grows left and down.
 */
export type PreviewResizeEdge = "left" | "bottom" | "corner";

/**
 * The scale after dragging `edge` by (dx, dy) from a drag that started at
 * `start`. The left edge moves the width, the bottom edge the height (the
 * other follows the aspect ratio); the corner follows whichever moved more.
 */
export function resizedPreviewScale(
  edge: PreviewResizeEdge,
  start: number,
  dx: number,
  dy: number,
  viewportWidth: number
): number {
  const left = -dx;
  const bottom = dy * (PREVIEW_VIRTUAL_WIDTH / PREVIEW_VIRTUAL_HEIGHT);
  const delta = { left, bottom, corner: Math.abs(left) > Math.abs(bottom) ? left : bottom }[edge];
  return clampPreviewScale(start + delta / PREVIEW_VIRTUAL_WIDTH, viewportWidth);
}

export function loadPreviewScale(
  viewportWidth: number,
  storage: KeyValueStorage | undefined = defaultLocalStorage()
): number {
  try {
    // A missing key reads as 0 — the default, not the minimum.
    const raw = Number(storage?.getItem(PREVIEW_SCALE_KEY));
    return Number.isFinite(raw) && raw > 0 ? clampPreviewScale(raw, viewportWidth) : DEFAULT_PREVIEW_SCALE;
  } catch {
    return DEFAULT_PREVIEW_SCALE;
  }
}

export function savePreviewScale(
  scale: number,
  storage: KeyValueStorage | undefined = defaultLocalStorage()
): void {
  try {
    storage?.setItem(PREVIEW_SCALE_KEY, String(scale));
  } catch {
    // Best effort.
  }
}
