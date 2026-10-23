/**
 * The `particles` background's small flock, simulated on the CPU so the motes
 * can feel each other: close ones drift apart, ones a little further off are
 * drawn loosely together and match their neighbours' heading, so the field
 * moves in slow, loose groups instead of every dot on its own orbit. Nearby
 * motes are joined by hairlines; the pointer gently parts them; a scroll gives
 * them a faint lag that settles again.
 *
 * Units are screen heights (x runs 0..aspect, y 0..1 top to bottom). Each mote
 * has a depth: near ones are larger, brighter and move further with the scroll
 * (depth parallax). Only motes at similar depths interact or are linked, so a
 * group stays together while the layers slide past each other.
 *
 * Pure apart from mutating the particle array, so it is tested without WebGL.
 */

export interface Particle {
  /** World position; see {@link screenX} / {@link screenY} for where it is drawn. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 0 (far) – 1 (near). */
  depth: number;
  phase: number;
}

export interface FieldStep {
  aspect: number;
  /** Seconds of simulated time. */
  dt: number;
  time: number;
  /** Scroll in screen heights, already scaled by the theme's parallax. */
  scroll: number;
  /** Smoothed scroll velocity, screen heights per second (positive = scrolling down). */
  velocity: number;
  /** Pointer in field units, with how present it is (0 – 1). */
  pointer: { x: number; y: number; strength: number } | null;
}

/** Motes may sit this far outside the screen, so they enter and leave softly. */
const PAD = 0.1;
const Y_PERIOD = 1 + 2 * PAD;

const FLOW = 0.012;
const RISE = 0.003;
/** Interaction range, and the distance inside which motes push apart. */
const RANGE = 0.15;
const SEPARATION = 0.045;
const SEPARATION_K = 0.25;
const COHESION_K = 0.012;
const ALIGN_K = 0.3;
/** Motes whose depths differ by more than this don't interact. */
const DEPTH_BAND = 0.25;
const DAMPING = 1.4;
const MAX_SPEED = 0.08;
const POINTER_RANGE = 0.18;
const POINTER_K = 0.6;
const SCROLL_K = 0.05;

const LINK = 0.12;
const MAX_LINKS = 400;

function wrap(v: number, period: number): number {
  return ((v % period) + period) % period;
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

/** How many motes a screen of this shape holds. */
export function particleCount(aspect: number): number {
  return Math.min(80, Math.max(24, Math.round(36 * aspect)));
}

/** A fresh field; the same `seed` lays out the same field. */
export function seedParticles(aspect: number, seed = 1): Particle[] {
  const random = mulberry32(seed);
  const width = aspect + 2 * PAD;
  return Array.from({ length: particleCount(aspect) }, () => ({
    x: random() * width,
    y: random() * Y_PERIOD,
    vx: 0,
    vy: 0,
    depth: random(),
    phase: random() * Math.PI * 2,
  }));
}

/** How far a mote at this depth moves per unit of (parallax-scaled) scroll. */
function depthParallax(depth: number): number {
  return 0.5 + 0.7 * depth;
}

export function screenX(p: Particle, aspect: number): number {
  return wrap(p.x, aspect + 2 * PAD) - PAD;
}

export function screenY(p: Particle, scroll: number): number {
  return wrap(p.y - scroll * depthParallax(p.depth), Y_PERIOD) - PAD;
}

/** Advance the field by `step.dt`, in place. */
export function stepParticles(particles: Particle[], step: FieldStep): void {
  const n = particles.length;
  const { dt } = step;
  if (n === 0 || dt <= 0) return;
  const sx = new Float64Array(n);
  const sy = new Float64Array(n);
  const ax = new Float64Array(n);
  const ay = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = particles[i];
    sx[i] = screenX(p, step.aspect);
    sy[i] = screenY(p, step.scroll);
    // A slow, swirling drift and a faint rise, so a still field still breathes.
    ax[i] += FLOW * Math.sin(sy[i] * 3.1 + step.time * 0.21 + p.phase);
    ay[i] += FLOW * Math.cos(sx[i] * 2.6 - step.time * 0.17 + p.phase * 1.3) - RISE;
    // Scrolling leaves the motes a little behind; the damping brings them back.
    ay[i] += step.velocity * SCROLL_K * p.depth;
  }

  for (let i = 0; i < n; i++) {
    const a = particles[i];
    for (let j = i + 1; j < n; j++) {
      const b = particles[j];
      const w = 1 - Math.abs(a.depth - b.depth) / DEPTH_BAND;
      if (w <= 0) continue;
      const dx = sx[j] - sx[i];
      const dy = sy[j] - sy[i];
      const d2 = dx * dx + dy * dy;
      if (d2 >= RANGE * RANGE) continue;
      const d = Math.sqrt(d2) || 1e-6;
      const nx = dx / d;
      const ny = dy / d;
      // Pushed apart when close, loosely drawn together a little further out.
      let f: number;
      if (d < SEPARATION) {
        f = -SEPARATION_K * (1 - d / SEPARATION);
      } else {
        const s = (d - SEPARATION) / (RANGE - SEPARATION);
        f = COHESION_K * 4 * s * (1 - s);
      }
      f *= w;
      // …and they gradually take each other's heading.
      const alx = (b.vx - a.vx) * ALIGN_K * w;
      const aly = (b.vy - a.vy) * ALIGN_K * w;
      ax[i] += f * nx + alx;
      ay[i] += f * ny + aly;
      ax[j] -= f * nx + alx;
      ay[j] -= f * ny + aly;
    }
  }

  const pointer = step.pointer;
  const decay = Math.exp(-DAMPING * dt);
  for (let i = 0; i < n; i++) {
    const p = particles[i];
    if (pointer && pointer.strength > 0) {
      const dx = sx[i] - pointer.x;
      const dy = sy[i] - pointer.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < POINTER_RANGE && d > 1e-6) {
        const push = POINTER_K * (1 - d / POINTER_RANGE) ** 2 * pointer.strength * (0.4 + 0.6 * p.depth);
        ax[i] += (dx / d) * push;
        ay[i] += (dy / d) * push;
      }
    }
    p.vx = (p.vx + ax[i] * dt) * decay;
    p.vy = (p.vy + ay[i] * dt) * decay;
    const speed = Math.hypot(p.vx, p.vy);
    if (speed > MAX_SPEED) {
      p.vx *= MAX_SPEED / speed;
      p.vy *= MAX_SPEED / speed;
    }
    p.x = wrap(p.x + p.vx * dt, step.aspect + 2 * PAD);
    p.y = wrap(p.y + p.vy * dt, Y_PERIOD);
  }
}

/** Vertex data for drawing: `[x, y, alpha, size]` per vertex, x/y in field units. */
export interface FieldGeometry {
  points: Float32Array;
  pointCount: number;
  lines: Float32Array;
  /** Two vertices per link. */
  lineVertexCount: number;
}

/**
 * Where to draw the field. `heightPx` is the drawing buffer's height, which
 * sizes the motes. The returned arrays are reused by the next call when passed
 * back in as `reuse`.
 */
export function fieldGeometry(
  particles: Particle[],
  aspect: number,
  scroll: number,
  heightPx: number,
  reuse?: FieldGeometry
): FieldGeometry {
  const n = particles.length;
  const points = reuse && reuse.points.length >= n * 4 ? reuse.points : new Float32Array(n * 4);
  const lines = reuse && reuse.lines.length >= MAX_LINKS * 8 ? reuse.lines : new Float32Array(MAX_LINKS * 8);
  const sx = new Float64Array(n);
  const sy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = particles[i];
    sx[i] = screenX(p, aspect);
    sy[i] = screenY(p, scroll);
    points[i * 4] = sx[i];
    points[i * 4 + 1] = sy[i];
    points[i * 4 + 2] = 0.3 + 0.55 * p.depth;
    points[i * 4 + 3] = (0.004 + 0.006 * p.depth) * heightPx;
  }
  let links = 0;
  for (let i = 0; i < n && links < MAX_LINKS; i++) {
    for (let j = i + 1; j < n && links < MAX_LINKS; j++) {
      const a = particles[i];
      const b = particles[j];
      if (Math.abs(a.depth - b.depth) > DEPTH_BAND) continue;
      const d = Math.hypot(sx[j] - sx[i], sy[j] - sy[i]);
      if (d >= LINK) continue;
      const alpha = (1 - d / LINK) ** 2 * 0.4 * (0.3 + 0.7 * Math.min(a.depth, b.depth));
      const o = links * 8;
      lines[o] = sx[i];
      lines[o + 1] = sy[i];
      lines[o + 2] = alpha;
      lines[o + 3] = 0;
      lines[o + 4] = sx[j];
      lines[o + 5] = sy[j];
      lines[o + 6] = alpha;
      lines[o + 7] = 0;
      links++;
    }
  }
  return { points, pointCount: n, lines, lineVertexCount: links * 2 };
}
