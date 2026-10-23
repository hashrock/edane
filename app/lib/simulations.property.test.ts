import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { clothGeometry, createCloth, stepCloth } from "./clothField";
import { dustCount, dustGeometry, dustScreenX, dustScreenY, seedDust, stepDust } from "./dustField";
import { createFog, fogTexels, stepFog } from "./fogField";
import { createShore, shoreTexels, stepShore } from "./shoreField";

const pointerArb = fc.option(
  fc.record({
    x: fc.double({ min: -1, max: 4, noNaN: true }),
    y: fc.double({ min: -1, max: 2, noNaN: true }),
    vx: fc.double({ min: -3, max: 3, noNaN: true }),
    vy: fc.double({ min: -3, max: 3, noNaN: true }),
    strength: fc.double({ min: 0, max: 1, noNaN: true }),
  }),
  { nil: null }
);
const stepArb = fc.record({
  dt: fc.double({ min: 0, max: 0.1, noNaN: true }),
  scroll: fc.double({ min: -50, max: 50, noNaN: true }),
  velocity: fc.double({ min: -3, max: 3, noNaN: true }),
  pointer: pointerArb,
});
const aspectArb = fc.double({ min: 0.4, max: 3, noNaN: true });

describe("dust", () => {
  it("keeps every mote finite and around the screen, however the air is stirred", () => {
    fc.assert(
      fc.property(aspectArb, fc.integer(), fc.array(stepArb, { minLength: 1, maxLength: 10 }), (aspect, seed, steps) => {
        const f = seedDust(aspect, seed);
        expect(f.n).toBe(dustCount(aspect));
        for (const s of steps) stepDust(f, { ...s, aspect });
        const scroll = steps[steps.length - 1].scroll;
        const geo = dustGeometry(f, aspect, scroll, 0, 900);
        for (let i = 0; i < f.n; i++) {
          const x = dustScreenX(f, i, aspect);
          const y = dustScreenY(f, i, scroll);
          expect(x).toBeGreaterThanOrEqual(-0.05);
          expect(x).toBeLessThanOrEqual(aspect + 0.05);
          expect(y).toBeGreaterThanOrEqual(-0.05);
          expect(y).toBeLessThanOrEqual(1.05);
          expect(geo[i * 4 + 2]).toBeGreaterThanOrEqual(0);
          expect(geo[i * 4 + 2]).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 30 }
    );
  });
});

describe("fog", () => {
  it("stays finite with densities in range, and lights the top fully", () => {
    fc.assert(
      fc.property(aspectArb, fc.array(stepArb, { minLength: 1, maxLength: 8 }), (aspect, steps) => {
        const f = createFog(aspect, 5);
        for (const s of steps) stepFog(f, s);
        for (let k = 0; k < f.nx * f.ny; k++) {
          expect(Number.isFinite(f.u[k]) && Number.isFinite(f.v[k]) && Number.isFinite(f.d[k])).toBe(true);
        }
        const texels = fogTexels(f);
        for (let i = 0; i < f.nx; i++) expect(texels[i * 2 + 1]).toBe(255);
        // Light only dims on its way down: no row is brighter, on the whole, than the row above.
        const rowLight = (j: number) => {
          let sum = 0;
          for (let i = 0; i < f.nx; i++) sum += texels[(j * f.nx + i) * 2 + 1];
          return sum;
        };
        for (let j = 1; j < f.ny; j++) expect(rowLight(j)).toBeLessThanOrEqual(rowLight(j - 1) + f.nx);
      }),
      { numRuns: 20 }
    );
  });

  it("projection leaves the flow (nearly) divergence-free", () => {
    const f = createFog(1.6, 30);
    const { nx, ny, u, v } = f;
    let total = 0;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const e = u[j * nx + ((i + 1) % nx)] - u[j * nx + ((i - 1 + nx) % nx)];
        const s = v[Math.min(ny - 1, j + 1) * nx + i] - v[Math.max(0, j - 1) * nx + i];
        total += Math.abs(0.5 * (e + s));
      }
    }
    let speed = 0;
    for (let k = 0; k < nx * ny; k++) speed += Math.abs(u[k]) + Math.abs(v[k]);
    expect(total / speed).toBeLessThan(0.2);
  });
});

describe("cloth", () => {
  it("stays finite, hangs from its rod and keeps roughly its length, however it is pushed", () => {
    fc.assert(
      fc.property(aspectArb, fc.array(stepArb, { minLength: 1, maxLength: 20 }), (aspect, steps) => {
        const c = createCloth(aspect, 10);
        let time = 0;
        for (const s of steps) {
          time += s.dt;
          stepCloth(c, { dt: s.dt, time, velocity: s.velocity, pointer: s.pointer });
        }
        for (let k = 0; k < c.pos.length; k++) expect(Number.isFinite(c.pos[k])).toBe(true);
        for (let k = 0; k < c.cols * 3; k++) expect(c.pos[k]).toBe(c.pins[k]);
        // The hem is still below the screen: the curtain hasn't torn or blown away.
        const hem = (c.rows - 1) * c.cols * 3;
        for (let i = 0; i < c.cols; i++) expect(c.pos[hem + i * 3 + 1]).toBeGreaterThan(0.9);
        const geo = clothGeometry(c);
        for (let v = 0; v < c.cols * c.rows; v++) {
          expect(geo[v * 4 + 2]).toBeGreaterThanOrEqual(0);
          expect(geo[v * 4 + 2]).toBeLessThanOrEqual(1);
        }
        expect(Math.max(...c.indices)).toBeLessThan(c.cols * c.rows);
      }),
      { numRuns: 30 }
    );
  });
});

describe("shore", () => {
  it("never drains a cell below empty, keeps every field in range, and roughly keeps its water", () => {
    fc.assert(
      fc.property(aspectArb, fc.array(stepArb, { minLength: 1, maxLength: 12 }), (aspect, steps) => {
        const s = createShore(aspect, 48, 0);
        let before = 0;
        for (const d of s.h) before += d;
        for (const step of steps) stepShore(s, step);
        let after = 0;
        for (let k = 0; k < s.nx * s.ny; k++) {
          expect(Number.isFinite(s.h[k]) && Number.isFinite(s.u[k]) && Number.isFinite(s.v[k])).toBe(true);
          expect(s.h[k]).toBeGreaterThanOrEqual(0);
          expect(s.wet[k]).toBeGreaterThanOrEqual(0);
          expect(s.wet[k]).toBeLessThanOrEqual(1);
          expect(s.foam[k]).toBeGreaterThanOrEqual(0);
          expect(s.foam[k]).toBeLessThanOrEqual(1.5);
          after += s.h[k];
        }
        // The wave maker adds and removes water at the top; nothing else should change the total much.
        expect(Math.abs(after - before) / before).toBeLessThan(0.1);
        expect(shoreTexels(s)).toHaveLength(s.nx * s.ny * 4);
      }),
      { numRuns: 15 }
    );
  });

  it("runs the swash up and down the beach and leaves the sand wet behind it", () => {
    const s = createShore(1.6, 64, 0);
    const col = Math.floor(s.nx / 2);
    const edge = () => {
      let last = 0;
      for (let j = 0; j < s.ny; j++) if (s.h[j * s.nx + col] > 0.0002) last = j;
      return last;
    };
    const edges: number[] = [];
    for (let f = 0; f < 60 * 15; f++) {
      stepShore(s, { dt: 1 / 60, velocity: 0, pointer: null });
      if (f % 15 === 0) edges.push(edge());
    }
    expect(Math.max(...edges) - Math.min(...edges)).toBeGreaterThanOrEqual(3);
    // Sand above the current waterline that the swash reached is still wet.
    const reach = Math.max(...edges);
    expect(s.wet[reach * s.nx + col]).toBeGreaterThan(0.3);
  });
});
