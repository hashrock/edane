import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { fieldGeometry, particleCount, screenX, screenY, seedParticles, stepParticles } from "./particleField";

const stepArb = fc.record({
  aspect: fc.double({ min: 0.4, max: 3, noNaN: true }),
  dt: fc.double({ min: 0, max: 0.1, noNaN: true }),
  time: fc.double({ min: 0, max: 1e4, noNaN: true }),
  scroll: fc.double({ min: -50, max: 50, noNaN: true }),
  velocity: fc.double({ min: -3, max: 3, noNaN: true }),
  pointer: fc.option(
    fc.record({
      x: fc.double({ min: -1, max: 4, noNaN: true }),
      y: fc.double({ min: -1, max: 2, noNaN: true }),
      strength: fc.double({ min: 0, max: 1, noNaN: true }),
    }),
    { nil: null }
  ),
});

describe("particleField", () => {
  it("keeps every mote finite and on (or just around) the screen, however it is driven", () => {
    fc.assert(
      fc.property(fc.integer(), fc.array(stepArb, { minLength: 1, maxLength: 30 }), (seed, steps) => {
        const aspect = steps[0].aspect;
        const particles = seedParticles(aspect, seed);
        for (const step of steps) stepParticles(particles, { ...step, aspect });
        const last = steps[steps.length - 1];
        for (const p of particles) {
          expect(Number.isFinite(p.vx) && Number.isFinite(p.vy)).toBe(true);
          expect(Math.hypot(p.vx, p.vy)).toBeLessThanOrEqual(0.08 + 1e-9);
          const x = screenX(p, aspect);
          const y = screenY(p, last.scroll);
          expect(x).toBeGreaterThanOrEqual(-0.1);
          expect(x).toBeLessThanOrEqual(aspect + 0.1);
          expect(y).toBeGreaterThanOrEqual(-0.1);
          expect(y).toBeLessThanOrEqual(1.1);
        }
      })
    );
  });

  it("lays out the same field for the same seed", () => {
    expect(seedParticles(1.6, 7)).toEqual(seedParticles(1.6, 7));
    expect(seedParticles(1.6, 7)).toHaveLength(particleCount(1.6));
  });

  it("links only nearby motes, faintly", () => {
    fc.assert(
      fc.property(fc.integer(), fc.double({ min: 0.4, max: 3, noNaN: true }), (seed, aspect) => {
        const particles = seedParticles(aspect, seed);
        const g = fieldGeometry(particles, aspect, 0, 900);
        expect(g.pointCount).toBe(particles.length);
        for (let v = 0; v < g.lineVertexCount; v += 2) {
          const o = v * 4;
          const d = Math.hypot(g.lines[o + 4] - g.lines[o], g.lines[o + 5] - g.lines[o + 1]);
          expect(d).toBeLessThan(0.12);
          expect(g.lines[o + 2]).toBeGreaterThanOrEqual(0);
          expect(g.lines[o + 2]).toBeLessThanOrEqual(0.4);
        }
      })
    );
  });

  it("parts around the pointer", () => {
    const particles = seedParticles(1, 3);
    const target = particles[0];
    const pointer = { x: screenX(target, 1) - 0.05, y: screenY(target, 0), strength: 1 };
    const before = screenX(target, 1);
    for (let i = 0; i < 10; i++) {
      stepParticles(particles, { aspect: 1, dt: 1 / 60, time: i / 60, scroll: 0, velocity: 0, pointer });
    }
    expect(screenX(target, 1)).toBeGreaterThan(before);
  });
});
