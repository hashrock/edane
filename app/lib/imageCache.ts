/**
 * Async image loader + size cache for image-type nodes.
 *
 * Loading an image is asynchronous, but the canvas redraw and the pretext-based
 * layout are synchronous. So we cache the loaded HTMLImageElement (and its
 * natural size) keyed by URL, start the load lazily the first time a URL is
 * requested, and notify subscribers when it finishes — the editor/viewer then
 * re-run layout + redraw with the real size.
 *
 * On environments without an Image constructor (Node test runner, SSR worker)
 * sizing falls back to a placeholder box.
 */

/** Image nodes never render taller than this (CSS `max-height: 200px`). */
export const IMAGE_MAX_HEIGHT = 200;
/** Vertical padding added around the image to form the node box. */
export const IMAGE_V_PAD = 14;

const PLACEHOLDER = { w: 240, h: 160 };
const ERROR_BOX = { w: 220, h: 48 };

type Entry =
  | { status: "loading" }
  | {
      status: "loaded";
      img: HTMLImageElement;
      naturalWidth: number;
      naturalHeight: number;
    }
  | { status: "error" };

const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

/** Subscribe to image load/error events; returns an unsubscribe fn. */
export function subscribeImages(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Get the cache entry for `url`, starting the load on first request. */
export function getImageEntry(url: string): Entry | undefined {
  if (!url) return undefined;
  const existing = cache.get(url);
  if (existing) return existing;
  if (typeof Image === "undefined") return undefined;

  const entry: Entry = { status: "loading" };
  cache.set(url, entry);
  const img = new Image();
  img.onload = () => {
    cache.set(url, {
      status: "loaded",
      img,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
    });
    notify();
  };
  img.onerror = () => {
    cache.set(url, { status: "error" });
    notify();
  };
  img.src = url;
  return entry;
}

export interface ImageDisplay {
  /** Display width (px). */
  w: number;
  /** Display height (px, capped to IMAGE_MAX_HEIGHT). */
  h: number;
  status: "loading" | "loaded" | "error";
  /** The loaded element (only when status === "loaded"). */
  img?: HTMLImageElement;
}

/** Display size for an image URL, scaled to respect IMAGE_MAX_HEIGHT. */
export function imageDisplaySize(url: string): ImageDisplay {
  const entry = getImageEntry(url);
  if (entry?.status === "loaded") {
    const scale =
      entry.naturalHeight > IMAGE_MAX_HEIGHT
        ? IMAGE_MAX_HEIGHT / entry.naturalHeight
        : 1;
    return {
      w: Math.max(1, entry.naturalWidth * scale),
      h: Math.max(1, entry.naturalHeight * scale),
      status: "loaded",
      img: entry.img,
    };
  }
  if (entry?.status === "error") {
    return { w: ERROR_BOX.w, h: ERROR_BOX.h, status: "error" };
  }
  return { w: PLACEHOLDER.w, h: PLACEHOLDER.h, status: "loading" };
}
