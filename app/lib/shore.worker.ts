/**
 * Runs the shore simulation (lib/shoreField.ts) off the main thread, so a
 * finely divided beach doesn't take frames from scrolling. Driven by
 * lib/shoreRunner.ts: "start" builds the beach, each "step" advances it and
 * answers with the texels to draw (the buffer is passed back and forth, not
 * copied).
 */
import { createShore, shoreTexels, stepShore, type Shore } from "./shoreField";
import type { ShoreFrame, ShoreRequest } from "./shoreRunner";

let shore: Shore | null = null;

self.onmessage = (e: MessageEvent<ShoreRequest>) => {
  const m = e.data;
  if (m.type === "start") {
    shore = createShore(m.aspect, m.rows);
  } else if (shore) {
    stepShore(shore, m.step);
  }
  if (!shore) return;
  const texels = shoreTexels(shore, m.buffer ? new Uint8Array(m.buffer) : undefined);
  const frame: ShoreFrame = { nx: shore.nx, ny: shore.ny, texels };
  (self as unknown as Worker).postMessage(frame, [texels.buffer]);
};
