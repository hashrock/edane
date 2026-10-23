/**
 * The `dust` background: a few thousand fine motes of powder carried by
 * turbulent air, glinting where they cross a soft beam of light.
 *
 * The air is a sum of eddies (Fourier modes of a stream function), so it is
 * divergence-free — motes swirl and shear apart instead of bunching up — and
 * its energy falls off with eddy size the way real turbulence does
 * (Kolmogorov: an eddy of wavenumber k moves at ~k^-1/3 and turns over at
 * ~k^2/3). Each mote follows the air with a little inertia and a little
 * Brownian jitter. A scroll stirs the air (gusts that die back down) and
 * leaves the motes slightly behind; the pointer drags a wake through them.
 *
 * Units are screen heights (x 0..aspect, y 0..1 top to bottom). Pure apart from
 * mutating the field, so it is tested without WebGL.
 */

export interface DustStep {
  aspect: number;
  /** Seconds of simulated time. */
  dt: number;
  /** Scroll in screen heights, already scaled by the theme's parallax. */
  scroll: number;
  /** Smoothed scroll velocity, screen heights per second (positive = scrolling down). */
  velocity: number;
  /** Pointer in field units with its velocity (units per second) and presence (0 – 1). */
  pointer: { x: number; y: number; vx: number; vy: number; strength: number } | null;
}

interface Eddy {
  kx: number;
  ky: number;
  amp: number;
  omega: number;
  phase: number;
}

export interface DustField {
  n: number;
  x: Float32Array;
  y: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  /** 0 (far) – 1 (near). */
  depth: Float32Array;
  phase: Float32Array;
  eddies: Eddy[];
  /** The air's own clock: runs faster while a scroll stirs it. */
  clock: number;
  /** How stirred the air is (0 – 2). */
  gust: number;
  random: () => number;
}

const PAD = 0.05;
const Y_PERIOD = 1 + 2 * PAD;
/** RMS air speed of the calm field, screen heights per second. */
const AIR = 0.035;
const DRIFT_X = 0.006;
const DRIFT_Y = -0.004;
/** Seconds a mote takes to pick up the air's speed. */
const RESPONSE = 0.35;
const BROWNIAN = 0.004;
const SCROLL_K = 0.05;
const WAKE_RADIUS2 = 0.006;

export function dustCount(aspect: number): number {
  return Math.min(2400, Math.max(600, Math.round(1100 * aspect)));
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function wrap(v: number, period: number): number {
  return ((v % period) + period) % period;
}

export function seedDust(aspect: number, seed = 1): DustField {
  const random = mulberry32(seed);
  const n = dustCount(aspect);
  const width = aspect + 2 * PAD;
  const field: DustField = {
    n,
    x: new Float32Array(n),
    y: new Float32Array(n),
    vx: new Float32Array(n),
    vy: new Float32Array(n),
    depth: new Float32Array(n),
    phase: new Float32Array(n),
    eddies: [],
    clock: 0,
    gust: 0,
    random,
  };
  for (let i = 0; i < n; i++) {
    field.x[i] = random() * width;
    field.y[i] = random() * Y_PERIOD;
    field.depth[i] = random();
    field.phase[i] = random() * Math.PI * 2;
  }
  // Six octaves of eddies, from half a screen across down to a few motes wide.
  for (let o = 0; o < 6; o++) {
    const k = 2 * 1.55 ** o;
    const angle = random() * Math.PI * 2;
    field.eddies.push({
      kx: k * Math.cos(angle),
      ky: k * Math.sin(angle),
      amp: AIR * k ** (-4 / 3),
      omega: 0.25 * k ** (2 / 3),
      phase: random() * Math.PI * 2,
    });
  }
  return field;
}

export function dustScreenX(f: DustField, i: number, aspect: number): number {
  return wrap(f.x[i], aspect + 2 * PAD) - PAD;
}

export function dustScreenY(f: DustField, i: number, scroll: number): number {
  return wrap(f.y[i] - scroll * (0.4 + 0.8 * f.depth[i]), Y_PERIOD) - PAD;
}

/**
 * The soft diagonal beam the motes glint in, 0 – 1, at screen position
 * (x 0..aspect, y 0..1 top to bottom). The `dust` shader draws the same beam.
 */
export function lightBeam(x: number, y: number, aspect: number): number {
  const s = (x - aspect * 0.55) * 0.55 + (y - 0.5) * 0.85;
  return Math.exp(-(s * s) / 0.06);
}

/** Advance the field by `step.dt`, in place. */
export function stepDust(f: DustField, step: DustStep): void {
  const { dt } = step;
  if (dt <= 0) return;
  // A scroll stirs the air quickly; it calms down slowly.
  const stir = Math.min(Math.abs(step.velocity), 2);
  f.gust += (stir - f.gust) * (1 - Math.exp(-dt / (stir > f.gust ? 0.15 : 1.2)));
  const intensity = 1 + 1.5 * f.gust;
  f.clock += dt * (1 + f.gust);
  const relax = 1 - Math.exp(-dt / RESPONSE);
  const jitter = BROWNIAN * Math.sqrt(dt);
  const width = step.aspect + 2 * PAD;
  const pointer = step.pointer && step.pointer.strength > 0 ? step.pointer : null;

  for (let i = 0; i < f.n; i++) {
    const sx = dustScreenX(f, i, step.aspect);
    const sy = dustScreenY(f, i, step.scroll);
    // Each depth sees a different part of the air, so the layers don't move in lockstep.
    const ax = sx + f.depth[i] * 3.7;
    let u = DRIFT_X;
    let v = DRIFT_Y + step.velocity * SCROLL_K * f.depth[i];
    for (const e of f.eddies) {
      const c = Math.cos(e.kx * ax + e.ky * sy + e.omega * f.clock + e.phase) * e.amp * intensity;
      u += e.ky * c;
      v -= e.kx * c;
    }
    if (pointer) {
      const dx = sx - pointer.x;
      const dy = sy - pointer.y;
      const w = Math.exp(-(dx * dx + dy * dy) / WAKE_RADIUS2) * pointer.strength;
      u += pointer.vx * 0.5 * w;
      v += pointer.vy * 0.5 * w;
    }
    f.vx[i] += (u - f.vx[i]) * relax;
    f.vy[i] += (v - f.vy[i]) * relax;
    const gx = f.random() + f.random() + f.random() - 1.5;
    const gy = f.random() + f.random() + f.random() - 1.5;
    f.x[i] = wrap(f.x[i] + f.vx[i] * dt + gx * jitter, width);
    f.y[i] = wrap(f.y[i] + f.vy[i] * dt + gy * jitter, Y_PERIOD);
  }
}

/**
 * Where to draw the motes: `[x, y, alpha, size]` per point, x/y in field
 * units. `heightPx` is the drawing buffer's height. `reuse` is filled when it
 * is large enough.
 */
export function dustGeometry(
  f: DustField,
  aspect: number,
  scroll: number,
  time: number,
  heightPx: number,
  reuse?: Float32Array
): Float32Array {
  const out = reuse && reuse.length >= f.n * 4 ? reuse : new Float32Array(f.n * 4);
  for (let i = 0; i < f.n; i++) {
    const sx = dustScreenX(f, i, aspect);
    const sy = dustScreenY(f, i, scroll);
    const d = f.depth[i];
    const twinkle = 0.6 + 0.4 * Math.sin(time * 1.7 + f.phase[i] * 7);
    out[i * 4] = sx;
    out[i * 4 + 1] = sy;
    out[i * 4 + 2] = (0.25 + 0.55 * d) * twinkle * (0.3 + 0.7 * lightBeam(sx, sy, aspect));
    out[i * 4 + 3] = Math.max(1, (0.0012 + 0.002 * d) * heightPx);
  }
  return out;
}
