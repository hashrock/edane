/**
 * The `haze` background: low-lying fog simulated as a fluid and lit from above.
 *
 * - Flow: Stam's "stable fluids" on a small grid (periodic sideways, walled
 *   above and below) — semi-Lagrangian
 *   advection, a pressure projection that keeps the air incompressible, and
 *   vorticity confinement, which gives back the small swirls the coarse grid
 *   would smear out. A gentle sheared breeze keeps it rolling; denser fog is
 *   heavier and settles. A scroll pushes the air (the fog lags behind the
 *   page and curls); the pointer drags it along.
 * - Fog: a density carried by the flow, slowly replenished toward banks that
 *   lie low with a thin layer higher up, as haze does.
 * - Light: {@link fogTexels} integrates the density along slanting rays of
 *   light from the upper left (Beer–Lambert), so fog under a dense bank is in
 *   its shade — soft, angled shafts — and only the fog the light reaches glows.
 *
 * Grid units: one cell = 1/{@link FOG_ROWS} of a screen height; velocities in
 * cells per second. Pure apart from mutating the field, so it is tested
 * without WebGL.
 */

export const FOG_ROWS = 36;

export interface FogStep {
  /** Seconds of simulated time. */
  dt: number;
  /** Smoothed scroll velocity, screen heights per second (positive = scrolling down). */
  velocity: number;
  /** Pointer in screen heights (x 0..aspect, y 0..1 top to bottom), its velocity and presence. */
  pointer: { x: number; y: number; vx: number; vy: number; strength: number } | null;
}

export interface Fog {
  nx: number;
  ny: number;
  u: Float32Array;
  v: Float32Array;
  d: Float32Array;
  /** Scratch buffers. */
  u0: Float32Array;
  v0: Float32Array;
  d0: Float32Array;
  p: Float32Array;
  div: Float32Array;
  curl: Float32Array;
  time: number;
}

const BREEZE = 2;
const BREEZE_PULL = 0.15;
const BUOYANCY = 1.5;
const CONFINEMENT = 3.5;
const REPLENISH = 0.04;
const SCROLL_PUSH = 0.25;
const MAX_SPEED = 12;
const PRESSURE_ITERATIONS = 16;
/** Optical thickness of a full screen of density 1. */
const SIGMA = 3;

function wrapIndex(i: number, n: number): number {
  return i < 0 ? i + n : i >= n ? i - n : i;
}

/** Rows end at walls: a neighbour past the top or bottom is the edge row itself. */
function clampIndex(j: number, n: number): number {
  return j < 0 ? 0 : j >= n ? n - 1 : j;
}

/** Cells the light moves sideways per row it falls. */
const LIGHT_SLANT = 0.6;

/** The fog the banks drift back toward, at row `j`. */
function bank(j: number, ny: number): number {
  const y = j / ny;
  const low = 0.55 * (y < 0.35 ? 0 : y > 0.9 ? 1 : ((y - 0.35) / 0.55) ** 2 * (3 - 2 * ((y - 0.35) / 0.55)));
  const high = 0.25 * Math.exp(-(((y - 0.3) / 0.08) ** 2));
  return low + high;
}

export function createFog(aspect: number, settle = 120): Fog {
  const ny = FOG_ROWS;
  const nx = Math.min(96, Math.max(16, Math.round(ny * aspect)));
  const size = nx * ny;
  const f: Fog = {
    nx,
    ny,
    u: new Float32Array(size),
    v: new Float32Array(size),
    d: new Float32Array(size),
    u0: new Float32Array(size),
    v0: new Float32Array(size),
    d0: new Float32Array(size),
    p: new Float32Array(size),
    div: new Float32Array(size),
    curl: new Float32Array(size),
    time: 0,
  };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      f.d[j * nx + i] = bank(j, ny) * (0.7 + 0.3 * Math.sin(i * 0.37 + j * 0.21) * Math.cos(i * 0.13 - j * 0.4));
    }
  }
  // Let it develop, so even a still (speed 0) background shows a formed fog.
  for (let s = 0; s < settle; s++) stepFog(f, { dt: 1 / 30, velocity: 0, pointer: null });
  return f;
}

/** Bilinear sample of `a` at cell coordinates (x, y): periodic in x, clamped at the walls in y. */
function sample(a: Float32Array, nx: number, ny: number, x: number, y: number): number {
  x = ((x % nx) + nx) % nx;
  y = Math.max(0, Math.min(ny - 1, y));
  const i0 = Math.floor(x);
  const j0 = Math.min(ny - 2, Math.floor(y));
  const i1 = i0 + 1 === nx ? 0 : i0 + 1;
  const j1 = j0 + 1;
  const sx = x - i0;
  const sy = y - j0;
  return (
    (a[j0 * nx + i0] * (1 - sx) + a[j0 * nx + i1] * sx) * (1 - sy) + (a[j1 * nx + i0] * (1 - sx) + a[j1 * nx + i1] * sx) * sy
  );
}

function advect(dst: Float32Array, src: Float32Array, f: Fog, dt: number) {
  const { nx, ny, u0, v0 } = f;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      dst[k] = sample(src, nx, ny, i - u0[k] * dt, j - v0[k] * dt);
    }
  }
}

/** Advance the fog by `step.dt`, in place. */
export function stepFog(f: Fog, step: FogStep): void {
  const { dt } = step;
  if (dt <= 0) return;
  const { nx, ny, u, v, d } = f;
  const size = nx * ny;

  let mean = 0;
  for (let k = 0; k < size; k++) mean += d[k];
  mean /= size;

  // Forces: the breeze, the weight of the fog, the scroll and the pointer.
  const pointer = step.pointer && step.pointer.strength > 0 ? step.pointer : null;
  const drag = Math.min(1, 6 * dt);
  for (let j = 0; j < ny; j++) {
    const breeze = BREEZE * Math.sin((2 * Math.PI * j) / ny + f.time * 0.07) + 0.6;
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      u[k] += (breeze - u[k]) * BREEZE_PULL * dt;
      v[k] += ((d[k] - mean) * BUOYANCY + step.velocity * ny * SCROLL_PUSH) * dt;
      if (pointer) {
        const dx = (i + 0.5) / ny - pointer.x;
        const dy = (j + 0.5) / ny - pointer.y;
        const w = Math.exp(-(dx * dx + dy * dy) / 0.004) * pointer.strength;
        u[k] += (pointer.vx * ny - u[k]) * w * drag;
        v[k] += (pointer.vy * ny - v[k]) * w * drag;
      }
    }
  }

  // Vorticity confinement: nudge the flow around its own swirls.
  const { curl } = f;
  for (let j = 0; j < ny; j++) {
    const jn = clampIndex(j - 1, ny) * nx;
    const js = clampIndex(j + 1, ny) * nx;
    for (let i = 0; i < nx; i++) {
      const iw = wrapIndex(i - 1, nx);
      const ie = wrapIndex(i + 1, nx);
      curl[j * nx + i] = 0.5 * (v[j * nx + ie] - v[j * nx + iw] - (u[js + i] - u[jn + i]));
    }
  }
  for (let j = 0; j < ny; j++) {
    const jn = clampIndex(j - 1, ny) * nx;
    const js = clampIndex(j + 1, ny) * nx;
    for (let i = 0; i < nx; i++) {
      const iw = wrapIndex(i - 1, nx);
      const ie = wrapIndex(i + 1, nx);
      const gx = 0.5 * (Math.abs(curl[j * nx + ie]) - Math.abs(curl[j * nx + iw]));
      const gy = 0.5 * (Math.abs(curl[js + i]) - Math.abs(curl[jn + i]));
      const len = Math.hypot(gx, gy) + 1e-5;
      const w = curl[j * nx + i];
      u[j * nx + i] += CONFINEMENT * (gy / len) * w * dt;
      v[j * nx + i] -= CONFINEMENT * (gx / len) * w * dt;
    }
  }

  for (let k = 0; k < size; k++) {
    u[k] = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, u[k]));
    v[k] = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, v[k]));
  }

  // Self-advection of the velocity.
  f.u0.set(u);
  f.v0.set(v);
  advect(u, f.u0, f, dt);
  advect(v, f.v0, f, dt);

  // Projection: remove the divergence, so the air neither piles up nor empties.
  const { p, div } = f;
  for (let j = 0; j < ny; j++) {
    const jn = clampIndex(j - 1, ny) * nx;
    const js = clampIndex(j + 1, ny) * nx;
    for (let i = 0; i < nx; i++) {
      div[j * nx + i] = -0.5 * (u[j * nx + wrapIndex(i + 1, nx)] - u[j * nx + wrapIndex(i - 1, nx)] + v[js + i] - v[jn + i]);
    }
  }
  p.fill(0);
  for (let it = 0; it < PRESSURE_ITERATIONS; it++) {
    for (let j = 0; j < ny; j++) {
      const jn = clampIndex(j - 1, ny) * nx;
      const js = clampIndex(j + 1, ny) * nx;
      for (let i = 0; i < nx; i++) {
        p[j * nx + i] =
          (div[j * nx + i] + p[j * nx + wrapIndex(i - 1, nx)] + p[j * nx + wrapIndex(i + 1, nx)] + p[jn + i] + p[js + i]) / 4;
      }
    }
  }
  for (let j = 0; j < ny; j++) {
    const jn = clampIndex(j - 1, ny) * nx;
    const js = clampIndex(j + 1, ny) * nx;
    for (let i = 0; i < nx; i++) {
      u[j * nx + i] -= 0.5 * (p[j * nx + wrapIndex(i + 1, nx)] - p[j * nx + wrapIndex(i - 1, nx)]);
      v[j * nx + i] -= 0.5 * (p[js + i] - p[jn + i]);
    }
  }
  for (let i = 0; i < nx; i++) {
    v[i] = 0;
    v[(ny - 1) * nx + i] = 0;
  }

  // The fog: drift back toward its banks, then ride the flow.
  for (let j = 0; j < ny; j++) {
    const target = bank(j, ny);
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      d[k] += (target - d[k]) * REPLENISH * dt;
    }
  }
  f.u0.set(u);
  f.v0.set(v);
  f.d0.set(d);
  advect(d, f.d0, f, dt);
  f.time += dt;
}

/**
 * The fog as a LUMINANCE_ALPHA texture, row 0 = the top of the screen:
 * luminance = density, alpha = how much of the light from above reaches the
 * cell (Beer–Lambert along its slanting ray through the fog above).
 */
export function fogTexels(f: Fog, reuse?: Uint8Array): Uint8Array {
  const { nx, ny, d } = f;
  const out = reuse && reuse.length >= nx * ny * 2 ? reuse : new Uint8Array(nx * ny * 2);
  // Optical depth reached at each cell of the current row, carried down row by
  // row along the slanting rays (sampled between columns, periodic sideways).
  let depth = new Float32Array(nx);
  let next = new Float32Array(nx);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const density = Math.max(0, Math.min(1, d[k]));
      out[k * 2] = Math.round(density * 255);
      out[k * 2 + 1] = Math.round(Math.exp(-depth[i] * SIGMA) * 255);
    }
    for (let i = 0; i < nx; i++) {
      // The ray reaching (i, j + 1) came through (i - slant, j).
      const x = i - LIGHT_SLANT;
      const i0 = Math.floor(x);
      const s = x - i0;
      const a = ((i0 % nx) + nx) % nx;
      const b = (a + 1) % nx;
      const through = (1 - s) * (depth[a] + Math.max(0, Math.min(1, d[j * nx + a])) / ny) + s * (depth[b] + Math.max(0, Math.min(1, d[j * nx + b])) / ny);
      next[i] = through;
    }
    [depth, next] = [next, depth];
  }
  return out;
}
