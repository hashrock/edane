/**
 * Drives the shore simulation for the background renderer: in a worker
 * (lib/shore.worker.ts) when one can be started, otherwise on this thread.
 *
 * The renderer asks for time to pass every frame; while the worker is still
 * busy with the last step, that time accumulates and goes with the next one,
 * so a slow device sees the sea move in bigger steps (and, past the
 * simulation's stability limit, slower) instead of the page stuttering.
 */
import { createShore, shoreTexels, stepShore, type Shore, type ShoreStep } from "./shoreField";

export type ShoreRequest =
  | { type: "start"; aspect: number; rows: number; buffer?: ArrayBuffer }
  | { type: "step"; step: ShoreStep; buffer?: ArrayBuffer };

/** One drawable state of the beach: an RGBA texture of `nx` × `ny` (see shoreTexels). */
export interface ShoreFrame {
  nx: number;
  ny: number;
  texels: Uint8Array;
}

export interface ShoreRunner {
  readonly rows: number;
  /** Let `step.dt` seconds pass (merged with whatever is still waiting). */
  advance(step: ShoreStep): void;
  /** The newest frame not yet taken, or null. */
  take(): ShoreFrame | null;
  /** Hand a taken frame's buffer back once it is on the GPU, to be filled again. */
  recycle(frame: ShoreFrame): void;
  destroy(): void;
}

/** `onFrame` is called whenever a new frame is ready to take. */
export function startShore(aspect: number, rows: number, onFrame: () => void): ShoreRunner {
  let ready: ShoreFrame | null = null;
  /** The buffer of the last frame taken, handed back for the next one. */
  let spare: ArrayBuffer | undefined;
  let waiting: ShoreStep | null = null;
  let busy = false;
  let destroyed = false;
  let local: Shore | null = null;
  let worker: Worker | null = null;

  const deliver = (frame: ShoreFrame) => {
    if (destroyed) return;
    ready = frame;
    onFrame();
  };

  const runLocally = () => {
    worker?.terminate();
    worker = null;
    busy = false;
    local = createShore(aspect, rows);
    deliver({ nx: local.nx, ny: local.ny, texels: shoreTexels(local) });
  };

  const send = () => {
    if (!worker || busy || !waiting) return;
    busy = true;
    const step = waiting;
    waiting = null;
    const buffer = spare;
    spare = undefined;
    worker.postMessage({ type: "step", step, buffer } satisfies ShoreRequest, buffer ? [buffer] : []);
  };

  try {
    worker = new Worker(new URL("./shore.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<ShoreFrame>) => {
      busy = false;
      deliver(e.data);
      send();
    };
    worker.onerror = (e) => {
      e.preventDefault();
      if (!destroyed) runLocally();
    };
    busy = true;
    worker.postMessage({ type: "start", aspect, rows } satisfies ShoreRequest);
  } catch {
    runLocally();
  }

  return {
    rows,
    advance(step) {
      if (destroyed || step.dt <= 0) return;
      // Time adds up; the newest scroll and pointer win.
      waiting = waiting ? { ...step, dt: waiting.dt + step.dt } : step;
      if (local) {
        stepShore(local, waiting);
        waiting = null;
        const buffer = spare;
        spare = undefined;
        deliver({ nx: local.nx, ny: local.ny, texels: shoreTexels(local, buffer ? new Uint8Array(buffer) : undefined) });
      } else {
        send();
      }
    },
    take() {
      const frame = ready;
      ready = null;
      return frame;
    },
    recycle(frame) {
      spare = frame.texels.buffer as ArrayBuffer;
    },
    destroy() {
      destroyed = true;
      worker?.terminate();
      worker = null;
      local = null;
    },
  };
}
