/**
 * The `cloth` background: a pleated curtain hanging from a rod across the top
 * of the screen, simulated with Verlet integration and distance constraints
 * (structural, shear and bending). The cloth is gathered on the rod (its
 * rest shape is pleated), so the curtain falls in folds; a slow wind makes it
 * breathe and billow, a scroll swings it (it hangs in a page that moves), and
 * the pointer presses into it.
 *
 * Positions are 3D in screen heights: x right, y down, z toward the viewer.
 * The view is orthographic; {@link clothGeometry} shades each vertex from its
 * normal (diffuse + a satin sheen). Pure apart from mutating the cloth, so it
 * is tested without WebGL.
 */

export interface ClothStep {
  /** Seconds of simulated time. */
  dt: number;
  time: number;
  /** Smoothed scroll velocity, screen heights per second (positive = scrolling down). */
  velocity: number;
  /** Pointer in screen heights (x 0..aspect, y 0..1 top to bottom), its velocity and presence. */
  pointer: { x: number; y: number; vx: number; vy: number; strength: number } | null;
}

export interface Cloth {
  cols: number;
  rows: number;
  pos: Float32Array;
  prev: Float32Array;
  /** The rest positions of the top row (the rod). */
  pins: Float32Array;
  /** Constraint endpoints and rest lengths; `stiff` is 1 for structure/shear, lower for bending. */
  a: Uint32Array;
  b: Uint32Array;
  rest: Float32Array;
  stiff: Float32Array;
  /** Two triangles per quad. */
  indices: Uint16Array;
  /** Leftover simulated time, below one fixed step. */
  carry: number;
}

const ROWS = 26;
const STEP = 1 / 60;
const MAX_STEPS = 4;
const ITERATIONS = 5;
const GRAVITY = 1.2;
const DAMPING = 0.985;
const WIND = 0.35;
/** Pleat depth (screen heights); each pleat spans PLEAT_COLUMNS columns. */
const PLEAT = 0.05;
const PLEAT_COLUMNS = 4;
const BENDING = 0.3;
const TOP = -0.04;
const LENGTH = 1.3;
const MARGIN = 0.15;

/** Light from the upper left, in front; the viewer looks down -z. */
const LIGHT = normalize([-0.5, -0.7, 0.8]);
const HALF = normalize([LIGHT[0], LIGHT[1], LIGHT[2] + 1]);

function normalize(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

export function createCloth(aspect: number, settle = 90): Cloth {
  const cols = Math.min(60, Math.max(20, Math.round(24 * aspect) + 1));
  const rows = ROWS;
  const n = cols * rows;
  const pos = new Float32Array(n * 3);
  const x0 = -MARGIN;
  const span = (aspect + 2 * MARGIN) / (cols - 1);
  const hy = LENGTH / (rows - 1);
  // Gathered: the rest shape waves in z, so the cloth between two pins is longer than the gap.
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = (j * cols + i) * 3;
      pos[k] = x0 + i * span;
      pos[k + 1] = TOP + j * hy;
      pos[k + 2] = PLEAT * Math.sin((i * 2 * Math.PI) / PLEAT_COLUMNS);
    }
  }
  const pins = pos.slice(0, cols * 3);

  const a: number[] = [];
  const b: number[] = [];
  const stiff: number[] = [];
  const link = (p: number, q: number, s: number) => {
    a.push(p);
    b.push(q);
    stiff.push(s);
  };
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      if (i + 1 < cols) link(k, k + 1, 1);
      if (j + 1 < rows) link(k, k + cols, 1);
      if (i + 1 < cols && j + 1 < rows) {
        link(k, k + cols + 1, 1);
        link(k + 1, k + cols, 1);
      }
      if (i + 2 < cols) link(k, k + 2, BENDING);
      if (j + 2 < rows) link(k, k + 2 * cols, BENDING);
    }
  }
  const rest = new Float32Array(a.length);
  for (let c = 0; c < a.length; c++) {
    const p = a[c] * 3;
    const q = b[c] * 3;
    rest[c] = Math.hypot(pos[q] - pos[p], pos[q + 1] - pos[p + 1], pos[q + 2] - pos[p + 2]);
  }

  const indices = new Uint16Array((cols - 1) * (rows - 1) * 6);
  let o = 0;
  for (let j = 0; j + 1 < rows; j++) {
    for (let i = 0; i + 1 < cols; i++) {
      const k = j * cols + i;
      indices.set([k, k + 1, k + cols, k + 1, k + cols + 1, k + cols], o);
      o += 6;
    }
  }

  const cloth: Cloth = {
    cols,
    rows,
    pos,
    prev: pos.slice(),
    pins,
    a: Uint32Array.from(a),
    b: Uint32Array.from(b),
    rest,
    stiff: Float32Array.from(stiff),
    indices,
    carry: 0,
  };
  // Let it hang and start to move, so even a still (speed 0) background is draped.
  for (let s = 0; s < settle; s++) stepCloth(cloth, { dt: STEP, time: s * STEP, velocity: 0, pointer: null });
  return cloth;
}

function substep(c: Cloth, time: number, velocity: number, pointer: ClothStep["pointer"]) {
  const { pos, prev, cols } = c;
  const n = cols * c.rows;
  const h2 = STEP * STEP;
  const swing = Math.min(Math.abs(velocity), 2);
  for (let v = cols; v < n; v++) {
    const k = v * 3;
    const x = pos[k];
    const y = pos[k + 1];
    const z = pos[k + 2];
    // Wind: two slow, crossing swells, stronger toward the hem.
    const reach = 0.2 + Math.max(0, y);
    let fz = WIND * reach * (0.6 * Math.sin(x * 1.4 + time * 0.5 + y * 0.8) + 0.4 * Math.sin(x * 3.1 - time * 0.8 + y * 2.3));
    fz += swing * 0.4 * Math.sin(x * 2 + time);
    let fx = WIND * 0.15 * reach * Math.sin(time * 0.3 + y * 1.7);
    let fy = GRAVITY + velocity * 0.8;
    if (pointer) {
      const dx = x - pointer.x;
      const dy = y - pointer.y;
      const d = Math.hypot(dx, dy);
      if (d < 0.15) {
        const w = (1 - d / 0.15) ** 2 * pointer.strength;
        fz -= 6 * w;
        fx += pointer.vx * 4 * w;
        fy += pointer.vy * 4 * w;
      }
    }
    const vx = (x - prev[k]) * DAMPING;
    const vy = (y - prev[k + 1]) * DAMPING;
    const vz = (z - prev[k + 2]) * DAMPING;
    prev[k] = x;
    prev[k + 1] = y;
    prev[k + 2] = z;
    pos[k] = x + vx + fx * h2;
    pos[k + 1] = y + vy + fy * h2;
    pos[k + 2] = z + vz + fz * h2;
  }
  for (let it = 0; it < ITERATIONS; it++) {
    for (let e = 0; e < c.a.length; e++) {
      const p = c.a[e];
      const q = c.b[e];
      const pk = p * 3;
      const qk = q * 3;
      const dx = pos[qk] - pos[pk];
      const dy = pos[qk + 1] - pos[pk + 1];
      const dz = pos[qk + 2] - pos[pk + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
      const diff = ((d - c.rest[e]) / d) * c.stiff[e];
      const pFixed = p < cols;
      const qFixed = q < cols;
      if (pFixed && qFixed) continue;
      const wp = pFixed ? 0 : qFixed ? 1 : 0.5;
      const wq = qFixed ? 0 : pFixed ? 1 : 0.5;
      pos[pk] += dx * diff * wp;
      pos[pk + 1] += dy * diff * wp;
      pos[pk + 2] += dz * diff * wp;
      pos[qk] -= dx * diff * wq;
      pos[qk + 1] -= dy * diff * wq;
      pos[qk + 2] -= dz * diff * wq;
    }
  }
}

/** Advance the cloth by `step.dt` (in fixed sub-steps), in place. */
export function stepCloth(c: Cloth, step: ClothStep): void {
  if (step.dt <= 0) return;
  c.carry = Math.min(c.carry + step.dt, STEP * MAX_STEPS);
  let time = step.time - c.carry;
  while (c.carry >= STEP) {
    c.carry -= STEP;
    time += STEP;
    substep(c, time, step.velocity, step.pointer);
  }
}

/**
 * Vertex data for drawing: `[x, y, shade, sheen]` per vertex, x/y in screen
 * heights (y down), shade 0 (in shadow) – 1 (lit), sheen 0 – 1.
 */
export function clothGeometry(c: Cloth, reuse?: Float32Array): Float32Array {
  const { cols, rows, pos } = c;
  const out = reuse && reuse.length >= cols * rows * 4 ? reuse : new Float32Array(cols * rows * 4);
  const at = (i: number, j: number) => (Math.min(rows - 1, Math.max(0, j)) * cols + Math.min(cols - 1, Math.max(0, i))) * 3;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const r = at(i + 1, j);
      const l = at(i - 1, j);
      const d = at(i, j + 1);
      const u = at(i, j - 1);
      const tx = [pos[r] - pos[l], pos[r + 1] - pos[l + 1], pos[r + 2] - pos[l + 2]];
      const ty = [pos[d] - pos[u], pos[d + 1] - pos[u + 1], pos[d + 2] - pos[u + 2]];
      const nrm = normalize([ty[2] * tx[1] - ty[1] * tx[2], tx[2] * ty[0] - tx[0] * ty[2], tx[0] * ty[1] - tx[1] * ty[0]]);
      // Cross(x, y) points toward the viewer for the flat sheet; keep it facing us.
      if (nrm[2] < 0) {
        nrm[0] = -nrm[0];
        nrm[1] = -nrm[1];
        nrm[2] = -nrm[2];
      }
      const diffuse = Math.max(0, nrm[0] * LIGHT[0] + nrm[1] * LIGHT[1] + nrm[2] * LIGHT[2]);
      const sheen = Math.max(0, nrm[0] * HALF[0] + nrm[1] * HALF[1] + nrm[2] * HALF[2]) ** 30;
      const k = (j * cols + i) * 3;
      const o = (j * cols + i) * 4;
      out[o] = pos[k];
      out[o + 1] = pos[k + 1];
      out[o + 2] = 0.15 + 0.85 * diffuse;
      out[o + 3] = sheen * 0.35;
    }
  }
  return out;
}
