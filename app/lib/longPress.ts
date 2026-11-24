/**
 * Long-press detection for touch: the touch-screen way to open a context
 * menu. iOS Safari never fires `contextmenu` for a long press, so the canvas
 * times the press itself.
 *
 * A press fires once it has been held for `delayMs` without the finger
 * travelling more than `tolerancePx` (a drag or a pan is not a long press) and
 * without a second finger landing (that's a pinch). Framework-free; the timer
 * functions are injectable so the rules can be tested without real time.
 */

export const LONG_PRESS_MS = 500;
export const LONG_PRESS_TOLERANCE_PX = 10;

export interface LongPressOptions<T> {
  delayMs?: number;
  tolerancePx?: number;
  onFire: (payload: T, x: number, y: number) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface LongPress<T> {
  /** A finger went down at client (x, y) on `payload` (e.g. a node id). */
  start(payload: T, x: number, y: number): void;
  /** The finger moved; cancels once it strays past the tolerance. */
  move(x: number, y: number): void;
  /** Finger lifted, a second finger landed, or the gesture was taken over. */
  cancel(): void;
  /** Whether the last press fired (so the caller can swallow its release). */
  readonly fired: boolean;
}

export function createLongPress<T>({
  delayMs = LONG_PRESS_MS,
  tolerancePx = LONG_PRESS_TOLERANCE_PX,
  onFire,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}: LongPressOptions<T>): LongPress<T> {
  let handle: unknown = null;
  let origin: { x: number; y: number } | null = null;
  let fired = false;

  const stop = () => {
    if (handle !== null) clearTimer(handle);
    handle = null;
    origin = null;
  };

  return {
    start(payload, x, y) {
      stop();
      fired = false;
      origin = { x, y };
      handle = setTimer(() => {
        handle = null;
        origin = null;
        fired = true;
        onFire(payload, x, y);
      }, delayMs);
    },
    move(x, y) {
      if (!origin) return;
      if (Math.hypot(x - origin.x, y - origin.y) > tolerancePx) stop();
    },
    cancel: stop,
    get fired() {
      return fired;
    },
  };
}
