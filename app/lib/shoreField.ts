/**
 * The `shore` background: a beach seen from above, sea at the top and sand at
 * the bottom, simulated with the shallow water equations.
 *
 * - Ground: a seabed rising to a beach, with a sandbar (cut by rip channels)
 *   that trips the bigger waves and gentle beach cusps along the shore.
 * - Water: depth h at cell centres and velocities on the cell faces (a
 *   staggered grid). The surface slope drives the flow, the flow carries itself
 *   (upwind advection, so waves steepen as they shoal and break into bores),
 *   and bottom friction — stronger the shallower and faster the water — slows
 *   the swash on the sand. Fluxes are limited so no cell is ever drained below
 *   empty, which lets the edge of the water run up and down the dry beach.
 *   Dry sand soaks up some of the thin swash (infiltration).
 * - Waves: generated in a relaxation zone at the top (which also absorbs what
 *   the beach reflects) from a few long-crested components arriving at a
 *   slight angle, so they come in sets.
 * - Breaking: where the surface rises faster than a fraction of the local
 *   wave speed. Breaking adds turbulent viscosity and makes foam; so does the
 *   fast, thin swash front. Foam rides the flow, gathers into lines where the
 *   flow converges and thins where it spreads, and slowly bursts — sooner when
 *   left on the sand, and unevenly: each patch of foam carries its own
 *   persistence (its bubble size), so it breaks up into holes and lace.
 * - Wetness: sand under water gets soaked at once and dries slowly after.
 * - Scroll and pointer: the page's acceleration sloshes the water; the pointer
 *   drags a wake through it.
 *
 * Lengths are in screen heights (horizontal and vertical alike), time in
 * seconds; the grid is periodic sideways. {@link shoreTexels} packs what the
 * shader draws. Pure apart from mutating the field, so it is tested without
 * WebGL.
 */

export interface ShoreStep {
  /** Seconds of simulated time. */
  dt: number;
  /** Smoothed scroll velocity, screen heights per second (positive = scrolling down). */
  velocity: number;
  /** Pointer in screen heights (x 0..aspect, y 0..1 top to bottom), its velocity and presence. */
  pointer: { x: number; y: number; vx: number; vy: number; strength: number } | null;
}

export interface Shore {
  nx: number;
  ny: number;
  /** Cell size, screen heights. */
  dx: number;
  /** Ground elevation (still water level = 0, up is positive). */
  bed: Float32Array;
  /** Water depth. */
  h: Float32Array;
  /** Velocity across the face left of cell (i, j) (x), and above it (y; ny + 1 rows, the last is the land wall). */
  u: Float32Array;
  v: Float32Array;
  foam: Float32Array;
  /** How long the foam in each cell lasts, 0 (big bubbles, gone soon) – 1 (fine, lasting); carried with the foam. */
  persist: Float32Array;
  wet: Float32Array;
  /** How hard each cell is breaking, 0 – 1. */
  breaking: Float32Array;
  /** Scratch. */
  fx: Float32Array;
  fy: Float32Array;
  out: Float32Array;
  hPrev: Float32Array;
  scratch: Float32Array;
  /** Periodic neighbour columns. */
  west: Int32Array;
  east: Int32Array;
  /** The wave maker's rows, with each wave's precomputed spatial (cos, sin) pairs per cell. */
  sponge: { rows: number; eta: Float32Array; u: Float32Array; v: Float32Array; cw: Float64Array; sw: Float64Array };
  time: number;
  /** The scroll velocity at the last step, for the page's acceleration. */
  lastVelocity: number;
  waves: Wave[];
}

interface Wave {
  kx: number;
  ky: number;
  omega: number;
  amp: number;
  phase: number;
}

const GRAVITY = 0.36;
/** Offshore depth: with GRAVITY, waves travel there at 0.12 screen heights per second. */
const DEPTH = 0.04;
/** Below this the cell is dry. */
const DRY = 0.0002;
/** Bottom friction coefficient (quadratic law). */
const FRICTION = 0.02;
/** Depth floor in the friction term, so the thinnest film doesn't stop dead. */
const FRICTION_DEPTH = 0.0006;
/** Infiltration into dry sand, screen heights per second. */
const INFILTRATION = 0.0015;
/** Breaking starts / is full when the surface rises at this fraction of the local wave speed. */
const BREAK_ONSET = 0.3;
const BREAK_FULL = 0.55;
const BREAK_VISCOSITY = 3e-4;
/** Foam made per second at full breaking, and by a fast thin swash front. */
const FOAM_BREAKING = 2.5;
const FOAM_FRONT = 6;
/** Seconds foam lasts on the water and on the sand. */
const FOAM_LIFE_WATER = 5;
const FOAM_LIFE_SAND = 2.5;
/**
 * Foam is not uniform: its bubbles differ in size, and coarse foam bursts long
 * before fine. Fresh foam takes its persistence from patches about this big
 * (screen heights), re-drawn this many times a second, and then carries it
 * along, mixing by amount; its lifetime scales by 0.3 – 1.9 with it.
 */
const FOAM_PATCH = 0.04;
const FOAM_PATCH_RATE = 1.5;
/**
 * How strongly foam gathers where the surface flow converges and thins where
 * it spreads (1 = plain conservation of foam; more draws the lace out).
 */
const FOAM_GATHER = 3;
/** Seconds wet sand takes to dry. */
const DRY_TIME = 14;
/** The relaxation zone that makes the waves: the top this fraction of the screen. */
const SPONGE = 0.16;
const SLOSH = 0.02;
const CFL = 0.45;
const MAX_SUBSTEPS = 8;

/** Depth at which the texture's depth channel saturates. */
const DEPTH_SCALE = 0.03;
const SLOPE_GAIN = 4;
const CURVATURE_GAIN = 0.15;
/** The light's direction across the screen: from the upper left. */
const LIGHT_X = -0.53;
const LIGHT_Y = -0.85;

/**
 * The model's constants, for the GPU version of the same simulation
 * (lib/shoreGpu.ts), which must stay in step with this one.
 */
export const SHORE_CONSTANTS = {
  GRAVITY,
  DEPTH,
  DRY,
  FRICTION,
  FRICTION_DEPTH,
  INFILTRATION,
  BREAK_ONSET,
  BREAK_FULL,
  BREAK_VISCOSITY,
  FOAM_BREAKING,
  FOAM_FRONT,
  FOAM_LIFE_WATER,
  FOAM_LIFE_SAND,
  FOAM_PATCH,
  FOAM_PATCH_RATE,
  FOAM_GATHER,
  DRY_TIME,
  SLOSH,
  CFL,
  DEPTH_SCALE,
  SLOPE_GAIN,
  CURVATURE_GAIN,
  LIGHT_X,
  LIGHT_Y,
} as const;

function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** The persistence fresh foam gets at (x, y) in a given re-draw `epoch`, 0 – 1 (value noise). */
export function freshPersistence(x: number, y: number, epoch: number): number {
  const gx = x / FOAM_PATCH + epoch * 17.3;
  const gy = y / FOAM_PATCH + epoch * 5.1;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const fx = gx - ix;
  const fy = gy - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const top = hash2(ix, iy) + (hash2(ix + 1, iy) - hash2(ix, iy)) * ux;
  const bottom = hash2(ix, iy + 1) + (hash2(ix + 1, iy + 1) - hash2(ix, iy + 1)) * ux;
  return top + (bottom - top) * uy;
}

/** How much longer than average foam of this persistence lasts. */
export function foamLifeScale(persist: number): number {
  return 0.3 + 1.6 * persist * persist;
}

/** How many rows of the beach make the wave maker. */
export function spongeRows(ny: number): number {
  return Math.max(2, Math.round(SPONGE * ny));
}

/** The ground at (x, y), screen heights. */
function bedAt(x: number, y: number, width: number): number {
  // Deep sea at the top shoaling to a beach that meets the still water line near y = 0.6.
  const toe = 0.22;
  const shoreline = 0.6;
  const slope = DEPTH / (shoreline - toe);
  let b = y < toe ? -DEPTH : -DEPTH + (y - toe) * slope;
  // Beach cusps: the shoreline scalloped along the beach.
  const cusp = Math.cos((x / width) * Math.PI * 2 * Math.max(1, Math.round(width / 0.35)));
  b += 0.002 * cusp * Math.exp(-(((y - shoreline) / 0.08) ** 2));
  // A sandbar offshore where the bigger waves trip, cut by rip channels (the
  // water the waves pile onto the beach runs back out through the gaps), and
  // wandering a little so the break isn't one straight line.
  const along = (x / width) * Math.PI * 2;
  const barY = 0.38 + 0.025 * Math.sin(along * 2 + 0.7) + 0.012 * Math.sin(along * 5 + 2.1);
  const rips = Math.max(1, Math.round(width / 0.8));
  const gap = Math.max(0, Math.cos(along * rips + 0.4)) ** 6;
  // Its crest stays a little under water even in a trough: a bar that dries and floods
  // between waves would ring out disturbances.
  b += 0.007 * Math.exp(-(((y - barY) / 0.04) ** 2)) * (1 - 0.85 * gap);
  // A berm above the reach of most swashes, then the dry beach.
  b += 0.004 * Math.exp(-(((y - 0.78) / 0.05) ** 2));
  return b;
}

function incoming(s: Shore, x: number, y: number, t: number): { eta: number; u: number; v: number } {
  let eta = 0;
  let u = 0;
  let v = 0;
  for (const w of s.waves) {
    const e = w.amp * Math.cos(w.kx * x + w.ky * y - w.omega * t + w.phase);
    eta += e;
    // Linear shallow-water waves: velocity = g k eta / omega, along k.
    u += (GRAVITY * w.kx * e) / w.omega;
    v += (GRAVITY * w.ky * e) / w.omega;
  }
  return { eta, u, v };
}

/**
 * The wave maker's spatial halves: for each sponge cell and wave, the (cos,
 * sin) of the wave's phase there — at the cell centre for the surface, on the
 * cell's x face for u and on its y face for v — already scaled by amplitude
 * and, for the velocities, by linear wave theory (velocity = g k eta / omega).
 */
function spongeTables(s: Shore): Shore["sponge"] {
  const { nx, ny, dx, waves } = s;
  const rows = spongeRows(ny);
  const n = rows * nx * waves.length * 2;
  const eta = new Float32Array(n);
  const u = new Float32Array(n);
  const v = new Float32Array(n);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < nx; i++) {
      for (let w = 0; w < waves.length; w++) {
        const wave = waves[w];
        const o = ((j * nx + i) * waves.length + w) * 2;
        const at = (x: number, y: number) => wave.kx * x + wave.ky * y + wave.phase;
        const pc = at((i + 0.5) * dx, (j + 0.5) * dx);
        const pu = at(i * dx, (j + 0.5) * dx);
        const pv = at((i + 0.5) * dx, j * dx);
        const su = (GRAVITY * wave.kx * wave.amp) / wave.omega;
        const sv = (GRAVITY * wave.ky * wave.amp) / wave.omega;
        eta[o] = wave.amp * Math.cos(pc);
        eta[o + 1] = wave.amp * Math.sin(pc);
        u[o] = su * Math.cos(pu);
        u[o + 1] = su * Math.sin(pu);
        v[o] = sv * Math.cos(pv);
        v[o + 1] = sv * Math.sin(pv);
      }
    }
  }
  return { rows, eta, u, v, cw: new Float64Array(waves.length), sw: new Float64Array(waves.length) };
}

/** A beach for a screen of this shape; `rows` sets how finely it is divided. */
export function createShore(aspect: number, rows = 128, settle = 0.5): Shore {
  const ny = Math.round(rows);
  const nx = Math.max(16, Math.round(ny * aspect));
  const dx = 1 / ny;
  const width = nx * dx;
  const size = nx * ny;
  const c0 = Math.sqrt(GRAVITY * DEPTH);
  // Two swells of close periods (they come in sets) and a little wind chop,
  // each a whole number of wavelengths across, so the periodic edges meet.
  const wave = (period: number, across: number, amp: number, phase: number): Wave => {
    const omega = (Math.PI * 2) / period;
    const k = omega / c0;
    const kx = (Math.PI * 2 * across) / width;
    return { kx, ky: Math.sqrt(Math.max(k * k - kx * kx, 0)), omega, amp, phase };
  };
  const s: Shore = {
    nx,
    ny,
    dx,
    bed: new Float32Array(size),
    h: new Float32Array(size),
    u: new Float32Array(size),
    v: new Float32Array(size + nx),
    foam: new Float32Array(size),
    persist: new Float32Array(size).fill(0.5),
    wet: new Float32Array(size),
    breaking: new Float32Array(size),
    fx: new Float32Array(size),
    fy: new Float32Array(size + nx),
    out: new Float32Array(size),
    hPrev: new Float32Array(size),
    scratch: new Float32Array(size),
    west: Int32Array.from({ length: nx }, (_, i) => (i === 0 ? nx - 1 : i - 1)),
    east: Int32Array.from({ length: nx }, (_, i) => (i === nx - 1 ? 0 : i + 1)),
    sponge: { rows: 0, eta: new Float32Array(0), u: new Float32Array(0), v: new Float32Array(0), cw: new Float64Array(0), sw: new Float64Array(0) },
    time: 0,
    lastVelocity: 0,
    waves: [wave(6.5, 1, 0.008, 0), wave(5.5, -1, 0.006, 1.7), wave(3, 3, 0.0015, 4.1)],
  };
  s.sponge = spongeTables(s);
  // Still water with the waves already on their way in, and the sand wet below the waterline.
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const x = (i + 0.5) * dx;
      const y = (j + 0.5) * dx;
      s.bed[k] = bedAt(x, y, width);
      const still = Math.max(0, -s.bed[k]);
      // Only offshore, fading out along a straight line before the seabed rises: an edge that
      // followed the depth would trace the bar and rip channels and ring out from them.
      const taper = Math.min(1, Math.max(0, (0.22 - y) / 0.08)) ** 2;
      const w = incoming(s, x, y, 0);
      s.h[k] = Math.max(0, still + w.eta * taper);
      s.u[k] = w.u * taper;
      s.v[k] = w.v * taper;
      s.wet[k] = s.bed[k] < 0.003 ? 1 : 0;
    }
  }
  let elapsed = 0;
  while (elapsed < settle) {
    stepShore(s, { dt: 1 / 30, velocity: 0, pointer: null });
    elapsed += 1 / 30;
  }
  return s;
}

/** The largest stable time step for the current flow. */
function stableStep(s: Shore): number {
  let fastest = 1e-6;
  const { h, u, v } = s;
  for (let k = 0; k < h.length; k++) {
    const c = Math.sqrt(GRAVITY * h[k]) + Math.abs(u[k]) + Math.abs(v[k]);
    if (c > fastest) fastest = c;
  }
  return (CFL * s.dx) / fastest;
}

/**
 * Advance the beach by `step.dt`, in place. The water itself moves in stable
 * sub-steps; foam, breaking, wetness and infiltration change slowly and are
 * updated once per step. When even the most sub-steps allowed can't cover
 * `dt` stably, the beach runs slower than real time rather than blowing up.
 */
export function stepShore(s: Shore, step: ShoreStep): void {
  if (step.dt <= 0) return;
  const accel = Math.max(-20, Math.min(20, (step.velocity - s.lastVelocity) / step.dt));
  s.lastVelocity = step.velocity;
  const limit = stableStep(s);
  let total = Math.min(step.dt, 0.1);
  let n = Math.ceil(total / limit);
  if (n > MAX_SUBSTEPS) {
    n = MAX_SUBSTEPS;
    total = n * limit;
  }
  const dt = total / n;
  s.hPrev.set(s.h);
  const pointer = step.pointer && step.pointer.strength > 0 ? step.pointer : null;
  if (pointer) dragWithPointer(s, pointer, total);
  for (let i = 0; i < n; i++) flow(s, dt, accel);
  surface(s, total);
}

/** The pointer drags the water it passes through. */
function dragWithPointer(s: Shore, pointer: NonNullable<ShoreStep["pointer"]>, dt: number) {
  const { nx, ny, dx, h, u, v } = s;
  const drag = Math.min(1, 8 * dt);
  for (let j = 0; j < ny; j++) {
    const dy = (j + 0.5) * dx - pointer.y;
    if (Math.abs(dy) > 0.12) continue;
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (h[k] < DRY) continue;
      const ddx = (i + 0.5) * dx - pointer.x;
      const w = Math.exp(-(ddx * ddx + dy * dy) / 0.0015) * pointer.strength * drag;
      u[k] += (pointer.vx * 0.3 - u[k]) * w;
      v[k] += (pointer.vy * 0.3 - v[k]) * w;
    }
  }
}

/** One sub-step of the shallow water equations. */
function flow(s: Shore, dt: number, accel: number) {
  const { nx, ny, bed, h, u, v, fx, fy, out, breaking, west, east } = s;
  const size = nx * ny;
  const idx = 1 / s.dx;
  const pressure = GRAVITY * dt * idx;
  const carry = dt * idx;
  const viscous = dt * BREAK_VISCOSITY * idx * idx;

  // --- Momentum, x faces: face (i, j) lies between cells (i - 1, j) and (i, j).
  for (let j = 0; j < ny; j++) {
    const row = j * nx;
    for (let i = 0; i < nx; i++) {
      const k = row + i;
      const kl = row + west[i];
      const hl = h[kl];
      const hr = h[k];
      const el = bed[kl] + hl;
      const er = bed[k] + hr;
      if ((hl < DRY && (hr < DRY || bed[kl] > er)) || (hr < DRY && bed[k] > el)) {
        out[k] = 0;
        continue;
      }
      const uk = u[k];
      const uw = u[kl];
      const ue = u[row + east[i]];
      // Upwind self-advection.
      const dudx = uk > 0 ? uk - uw : ue - uk;
      const vc = 0.25 * (v[k] + v[kl] + v[k + nx] + v[kl + nx]);
      const un = j > 0 ? u[k - nx] : uk;
      const us = j < ny - 1 ? u[k + nx] : uk;
      const dudy = vc > 0 ? uk - un : us - uk;
      let next = uk - pressure * (er - el) - carry * (uk * dudx + vc * dudy);
      // Turbulent viscosity where the wave is breaking.
      const b = breaking[k] > breaking[kl] ? breaking[k] : breaking[kl];
      if (b > 0) next += viscous * b * (uw + ue + un + us - 4 * uk);
      // Bottom friction, implicit (it only ever slows the water down).
      const depth = Math.max(0.5 * (hl + hr), FRICTION_DEPTH);
      next /= 1 + (dt * FRICTION * Math.sqrt(next * next + vc * vc)) / depth;
      out[k] = next;
    }
  }
  u.set(out);

  // --- Momentum, y faces: face (i, j) lies between cells (i, j - 1) and (i, j); rows 0 and ny are the sea and the land wall.
  const slosh = dt * SLOSH * accel;
  for (let j = 1; j < ny; j++) {
    const row = j * nx;
    for (let i = 0; i < nx; i++) {
      const k = row + i;
      const ka = k - nx;
      const ha = h[ka];
      const hb = h[k];
      const ea = bed[ka] + ha;
      const eb = bed[k] + hb;
      if ((ha < DRY && (hb < DRY || bed[ka] > eb)) || (hb < DRY && bed[k] > ea)) {
        out[k] = 0;
        continue;
      }
      const vk = v[k];
      const vn = v[ka];
      const vs = v[k + nx];
      const dvdy = vk > 0 ? vk - vn : vs - vk;
      const e = east[i];
      const uc = 0.25 * (u[k] + u[row + e] + u[ka] + u[ka - i + e]);
      const vw = v[row + west[i]];
      const ve = v[row + e];
      const dvdx = uc > 0 ? vk - vw : ve - vk;
      // The page's acceleration: the water lags behind it.
      let next = vk - pressure * (eb - ea) - carry * (vk * dvdy + uc * dvdx) + slosh;
      const b = breaking[k] > breaking[ka] ? breaking[k] : breaking[ka];
      if (b > 0) next += viscous * b * (vw + ve + vn + vs - 4 * vk);
      const depth = Math.max(0.5 * (ha + hb), FRICTION_DEPTH);
      next /= 1 + (dt * FRICTION * Math.sqrt(next * next + uc * uc)) / depth;
      out[k] = next;
    }
  }
  for (let i = 0; i < nx; i++) out[i] = v[i];
  v.set(out.subarray(0, size));
  v.fill(0, size);

  // --- Continuity: upwind fluxes, limited so no cell gives more water than it has.
  for (let j = 0; j < ny; j++) {
    const row = j * nx;
    for (let i = 0; i < nx; i++) {
      const k = row + i;
      const uk = u[k];
      fx[k] = uk * (uk > 0 ? h[row + west[i]] : h[k]);
      const vk = v[k];
      fy[k] = j === 0 ? 0 : vk * (vk > 0 ? h[k - nx] : h[k]);
    }
  }
  fy.fill(0, size);
  // Each cell's limiter: the share of its planned outflow it can actually give.
  for (let j = 0; j < ny; j++) {
    const row = j * nx;
    for (let i = 0; i < nx; i++) {
      const k = row + i;
      const a = fx[k];
      const b = fx[row + east[i]];
      const c = fy[k];
      const d = fy[k + nx];
      const need = ((a < 0 ? -a : 0) + (b > 0 ? b : 0) + (c < 0 ? -c : 0) + (d > 0 ? d : 0)) * carry;
      out[k] = need > h[k] ? h[k] / need : 1;
    }
  }
  for (let j = 0; j < ny; j++) {
    const row = j * nx;
    for (let i = 0; i < nx; i++) {
      const k = row + i;
      fx[k] *= fx[k] > 0 ? out[row + west[i]] : out[k];
      if (j > 0) fy[k] *= fy[k] > 0 ? out[k - nx] : out[k];
    }
  }
  for (let j = 0; j < ny; j++) {
    const row = j * nx;
    for (let i = 0; i < nx; i++) {
      const k = row + i;
      const next = h[k] - carry * (fx[row + east[i]] - fx[k] + fy[k + nx] - fy[k]);
      h[k] = next > 0 ? next : 0;
    }
  }

  // --- The wave maker: relax the top rows toward the incoming waves (and absorb what comes back).
  // cos(phase - wt) = cos(phase) cos(wt) + sin(phase) sin(wt): the spatial halves are precomputed.
  const sp = s.sponge;
  const cw = sp.cw;
  const sw = sp.sw;
  for (let w = 0; w < s.waves.length; w++) {
    cw[w] = Math.cos(s.waves[w].omega * s.time);
    sw[w] = Math.sin(s.waves[w].omega * s.time);
  }
  const waves = s.waves.length;
  for (let j = 0; j < sp.rows; j++) {
    const pull = Math.min(1, dt * 6 * ((sp.rows - j) / sp.rows) ** 2);
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      let eta = 0;
      let uu = 0;
      let vv = 0;
      for (let w = 0; w < waves; w++) {
        const o = k * waves + w;
        eta += sp.eta[o * 2] * cw[w] + sp.eta[o * 2 + 1] * sw[w];
        uu += sp.u[o * 2] * cw[w] + sp.u[o * 2 + 1] * sw[w];
        vv += sp.v[o * 2] * cw[w] + sp.v[o * 2 + 1] * sw[w];
      }
      const target = eta - bed[k];
      h[k] += ((target > 0 ? target : 0) - h[k]) * pull;
      u[k] += (uu - u[k]) * pull;
      if (j > 0) v[k] += (vv - v[k]) * pull;
    }
  }
  s.time += dt;
}

/** Infiltration, breaking, foam and wetness over the last `dt` seconds. */
function surface(s: Shore, dt: number) {
  const { nx, ny, h, u, v, breaking, foam, wet, hPrev, east } = s;
  const size = nx * ny;
  const idx = 1 / s.dx;
  const fade = Math.exp(-dt / 0.4);
  const dryOut = Math.exp(-dt / DRY_TIME);
  const { persist, dx } = s;
  const epoch = Math.floor(s.time * FOAM_PATCH_RATE);
  for (let k = 0; k < size; k++) {
    const depth = h[k];
    if (depth > 0 && depth < 0.004) h[k] = Math.max(0, depth - dt * INFILTRATION * (1 - 0.8 * wet[k]));
    const rise = (h[k] - hPrev[k]) / dt;
    const ratio = rise / Math.sqrt(GRAVITY * Math.max(h[k], 0.001));
    const target = h[k] < DRY ? 0 : Math.min(1, Math.max(0, (ratio - BREAK_ONSET) / (BREAK_FULL - BREAK_ONSET)));
    // A breaker keeps breaking for a moment after its front has passed.
    breaking[k] = Math.max(target, breaking[k] * fade);
  }
  for (let j = 0; j < ny; j++) {
    const row = j * nx;
    for (let i = 0; i < nx; i++) {
      const k = row + i;
      let f = foam[k];
      if (h[k] >= DRY) {
        const uc = 0.5 * (u[k] + u[row + east[i]]);
        const vc = 0.5 * (v[k] + v[k + nx]);
        const speed = Math.sqrt(uc * uc + vc * vc);
        const front = h[k] < 0.004 ? Math.max(0, speed - 0.06) : 0;
        // Carried foam is squeezed together where the flow converges, spread thin where it diverges.
        const divergence = (u[row + east[i]] - u[k] + v[k + nx] - v[k]) * idx;
        const added = dt * (FOAM_BREAKING * breaking[k] + FOAM_FRONT * front);
        if (added > 0) {
          const fresh = freshPersistence((i + 0.5) * dx, (j + 0.5) * dx, epoch);
          persist[k] = (f * persist[k] + added * fresh) / (f + added);
        }
        const life = FOAM_LIFE_WATER * foamLifeScale(persist[k]);
        f = (f + added) * Math.exp(-dt / life - FOAM_GATHER * divergence * dt);
        wet[k] = 1;
      } else {
        f *= Math.exp(-dt / (FOAM_LIFE_SAND * foamLifeScale(persist[k])));
        wet[k] *= dryOut;
      }
      foam[k] = f < 1.5 ? f : 1.5;
    }
  }
  // Foam, and how long it lasts, ride the surface flow (semi-Lagrangian).
  const { scratch, out } = s;
  for (let j = 0; j < ny; j++) {
    const row = j * nx;
    for (let i = 0; i < nx; i++) {
      const k = row + i;
      if (h[k] < DRY) {
        scratch[k] = foam[k];
        out[k] = persist[k];
        continue;
      }
      const uc = 0.5 * (u[k] + u[row + east[i]]);
      const vc = 0.5 * (v[k] + v[k + nx]);
      const x = i - uc * dt * idx;
      const y = j - vc * dt * idx;
      scratch[k] = sampleField(foam, nx, ny, x, y);
      out[k] = sampleField(persist, nx, ny, x, y);
    }
  }
  foam.set(scratch);
  persist.set(out);
}

function sampleField(a: Float32Array, nx: number, ny: number, x: number, y: number): number {
  x = ((x % nx) + nx) % nx;
  y = Math.max(0, Math.min(ny - 1, y));
  const i0 = Math.floor(x);
  const j0 = Math.min(ny - 2, Math.floor(y));
  const i1 = i0 + 1 === nx ? 0 : i0 + 1;
  const sx = x - i0;
  const sy = y - j0;
  const top = a[j0 * nx + i0] * (1 - sx) + a[j0 * nx + i1] * sx;
  const bottom = a[(j0 + 1) * nx + i0] * (1 - sx) + a[(j0 + 1) * nx + i1] * sx;
  return top * (1 - sy) + bottom * sy;
}

/**
 * The beach as an RGBA texture, row 0 = the top of the screen:
 * R = water depth (square-root scaled, so the thinnest swash still registers),
 * G = foam, B = wet sand, A = light on the water surface (0.5 = flat; its
 * slope toward the light and its curvature — which focuses light into
 * caustics on the sand below — brighten or darken it).
 */
export function shoreTexels(s: Shore, reuse?: Uint8Array): Uint8Array {
  const { nx, ny, dx, bed, h } = s;
  const out = reuse && reuse.length >= nx * ny * 4 ? reuse : new Uint8Array(nx * ny * 4);
  const surface = (i: number, j: number) => {
    const k = Math.max(0, Math.min(ny - 1, j)) * nx + ((i + nx) % nx);
    return bed[k] + h[k];
  };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      let light = 0.5;
      if (h[k] >= DRY) {
        const c = surface(i, j);
        // Sobel: the slope over the 3×3 neighbourhood, so a bore crossing the
        // grid at an angle shades as a smooth front, not a staircase.
        const gx =
          (surface(i + 1, j - 1) + 2 * surface(i + 1, j) + surface(i + 1, j + 1) -
            surface(i - 1, j - 1) - 2 * surface(i - 1, j) - surface(i - 1, j + 1)) /
          (8 * dx);
        const gy =
          (surface(i - 1, j + 1) + 2 * surface(i, j + 1) + surface(i + 1, j + 1) -
            surface(i - 1, j - 1) - 2 * surface(i, j - 1) - surface(i + 1, j - 1)) /
          (8 * dx);
        // Without the beach's own slope: only the waves on it catch the light.
        const bx = (bed[j * nx + ((i + 1) % nx)] - bed[j * nx + ((i - 1 + nx) % nx)]) / (2 * dx);
        const by = (bed[Math.min(ny - 1, j + 1) * nx + i] - bed[Math.max(0, j - 1) * nx + i]) / (2 * dx);
        const deep = Math.min(1, h[k] / 0.004);
        const facing = -((gx - bx * (1 - deep)) * LIGHT_X + (gy - by * (1 - deep)) * LIGHT_Y) * SLOPE_GAIN;
        const curvature =
          (surface(i + 1, j) + surface(i - 1, j) + surface(i, j + 1) + surface(i, j - 1) - 4 * c) / (dx * dx);
        light = 0.5 + 0.5 * Math.max(-1, Math.min(1, facing - curvature * CURVATURE_GAIN));
      }
      const o = k * 4;
      out[o] = Math.round(Math.sqrt(Math.min(1, h[k] / DEPTH_SCALE)) * 255);
      out[o + 1] = Math.round(Math.min(1, s.foam[k]) * 255);
      out[o + 2] = Math.round(s.wet[k] * 255);
      out[o + 3] = Math.round(light * 255);
    }
  }
  return out;
}

/** How finely to divide the beach for a drawing buffer this many pixels high. */
export function shoreRows(heightPx: number): number {
  return Math.max(48, Math.min(256, Math.round(heightPx / 4)));
}
