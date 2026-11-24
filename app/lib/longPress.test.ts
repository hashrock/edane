import { describe, it, expect } from "vitest";
import { createLongPress } from "./longPress";

/** A manual clock: timers run only when `advance` passes their due time. */
function clock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (h: unknown) => void timers.delete(h as number),
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
  };
}

function setup() {
  const c = clock();
  const fires: [string, number, number][] = [];
  const lp = createLongPress<string>({
    delayMs: 500,
    tolerancePx: 10,
    onFire: (p, x, y) => fires.push([p, x, y]),
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
  });
  return { c, fires, lp };
}

describe("createLongPress", () => {
  it("fires once the finger is held still for the delay", () => {
    const { c, fires, lp } = setup();
    lp.start("n1", 100, 200);
    c.advance(499);
    expect(fires).toEqual([]);
    c.advance(1);
    expect(fires).toEqual([["n1", 100, 200]]);
    expect(lp.fired).toBe(true);
  });

  it("tolerates jitter within the radius", () => {
    const { c, fires, lp } = setup();
    lp.start("n1", 100, 100);
    lp.move(106, 106); // ≈ 8.5px
    c.advance(500);
    expect(fires).toHaveLength(1);
  });

  it("a drag or pan is not a long press", () => {
    const { c, fires, lp } = setup();
    lp.start("n1", 100, 100);
    lp.move(115, 100);
    lp.move(100, 100); // coming back doesn't re-arm
    c.advance(1000);
    expect(fires).toEqual([]);
    expect(lp.fired).toBe(false);
  });

  it("lifting the finger early cancels", () => {
    const { c, fires, lp } = setup();
    lp.start("n1", 0, 0);
    c.advance(300);
    lp.cancel();
    c.advance(1000);
    expect(fires).toEqual([]);
  });

  it("a new press re-arms and forgets the previous one", () => {
    const { c, fires, lp } = setup();
    lp.start("n1", 0, 0);
    c.advance(500);
    expect(lp.fired).toBe(true);
    lp.start("n2", 5, 5);
    expect(lp.fired).toBe(false);
    c.advance(500);
    expect(fires.map(([p]) => p)).toEqual(["n1", "n2"]);
  });
});
