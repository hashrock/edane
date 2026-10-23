/**
 * The page view's animated background: one full-canvas WebGL fragment shader
 * with a few presets, two colours, a speed and a parallax factor (how far the
 * pattern follows the scroll). Framework-free, so the published page's small
 * runtime script and the editor's React views both drive it.
 *
 * Every preset is meant to sit quietly behind text: low contrast, slow, and
 * reacting to the reader only faintly.
 *
 * - The scroll is followed with a little inertia, and its smoothed velocity is
 *   passed on: a quick scroll stretches, stirs or swings the background a
 *   touch, and it settles again when the page stops.
 * - Some presets are physical simulations run on the CPU and drawn over (or
 *   fed into) the shader: `particles` (a flock, lib/particleField.ts), `dust`
 *   (powder in turbulent air, lib/dustField.ts), `haze` (fog as a fluid,
 *   lib/fogField.ts), `shore` (a beach in shallow water, lib/shoreField.ts, run
 *   on the GPU by lib/shoreGpu.ts, or failing that in a worker by
 *   lib/shoreRunner.ts) and
 *   `cloth` (a hanging curtain, lib/clothField.ts). They
 *   also react to the pointer.
 * - Preset `none`, a missing WebGL context, or a lost one draw nothing: the
 *   canvas stays transparent over the page's solid `--wp-bg`.
 * - `prefers-reduced-motion` freezes the animation, the simulations and the
 *   scroll reactions; scrolling still moves it.
 * - Frames are only drawn when something changed (time running, scroll moving
 *   or settling, options or size changed), so a still background costs nothing.
 */
import { clothGeometry, createCloth, stepCloth, type Cloth } from "./clothField";
import { dustGeometry, seedDust, stepDust, type DustField } from "./dustField";
import { createFog, fogTexels, stepFog, type Fog } from "./fogField";
import { shoreRows } from "./shoreField";
import { shoreGpuRows, startShoreGpu, type ShoreGpu } from "./shoreGpu";
import { startShore, type ShoreFrame, type ShoreRunner } from "./shoreRunner";
import { fieldGeometry, seedParticles, stepParticles, type FieldGeometry, type Particle } from "./particleField";

/** The background part of a page theme (domain/pageTheme.ts `PageBackground`). */
export interface BackgroundOptions {
  /** A preset name; unknown names draw nothing, like `none`. */
  preset: string;
  /** `#rrggbb`. */
  colorA: string;
  /** `#rrggbb`. */
  colorB: string;
  speed: number;
  parallax: number;
}

export interface BackgroundHandle {
  update(options: BackgroundOptions): void;
  /** Ask for a redraw (the scroll position changed). */
  invalidate(): void;
  destroy(): void;
}

/** The shader's preset numbers. */
const PRESET_INDEX: Readonly<Record<string, number>> = {
  gradient: 1,
  waves: 2,
  particles: 3,
  aurora: 4,
  silk: 5,
  haze: 6,
  contour: 7,
  dust: 8,
  shore: 9,
  cloth: 10,
};

type SimKind = "flock" | "dust" | "fog" | "shore" | "cloth";

/** Presets backed by a CPU simulation. */
const PRESET_SIM: Readonly<Record<string, SimKind>> = {
  particles: "flock",
  dust: "dust",
  haze: "fog",
  shore: "shore",
  cloth: "cloth",
};

type Sim =
  | { kind: "flock"; aspect: number; particles: Particle[]; geometry?: FieldGeometry }
  | { kind: "dust"; aspect: number; field: DustField; points?: Float32Array }
  | { kind: "fog"; aspect: number; fog: Fog; texels?: Uint8Array }
  /** On the GPU when it can; otherwise `frame` is the worker's newest state, `uploaded` once it is in the texture. */
  | { kind: "shore"; aspect: number; rows: number; gpu: ShoreGpu }
  | { kind: "shore"; aspect: number; rows: number; gpu: null; runner: ShoreRunner; frame: ShoreFrame | null; uploaded: boolean }
  | { kind: "cloth"; aspect: number; cloth: Cloth; vertices?: Float32Array };

/**
 * `heightPx` (the drawing buffer's height) sets how finely the beach is
 * divided; `onFrame` is called when the beach, if it is computed in a worker,
 * has a new state to draw.
 */
function createSim(gl: WebGLRenderingContext, kind: SimKind, aspect: number, heightPx: number, onFrame: () => void): Sim {
  switch (kind) {
    case "flock":
      return { kind, aspect, particles: seedParticles(aspect) };
    case "dust":
      return { kind, aspect, field: seedDust(aspect) };
    case "fog":
      return { kind, aspect, fog: createFog(aspect) };
    case "shore":
    {
      const rows = shoreGpuRows(heightPx);
      const gpu = startShoreGpu(gl, aspect, rows);
      if (gpu) return { kind, aspect, rows, gpu };
      const cpuRows = shoreRows(heightPx);
      return { kind, aspect, rows: cpuRows, gpu: null, runner: startShore(aspect, cpuRows, onFrame), frame: null, uploaded: false };
    }
    case "cloth":
      return { kind, aspect, cloth: createCloth(aspect) };
  }
}

/** Seconds the drawn scroll position takes to catch up (~63%) with the real one. */
const SCROLL_LAG = 0.18;
/** Seconds over which the scroll velocity is smoothed. */
const VELOCITY_LAG = 0.25;
/** A scroll jump larger than this (screen heights) is taken at once, not swept through. */
const SCROLL_SNAP = 2;
/** Seconds the pointer keeps acting on a simulation after it last moved. */
const POINTER_LINGER = 1.5;
/** A simulation is rebuilt when the screen's shape changes by more than this fraction. */
const RESHAPE = 0.25;

const VERTEX = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 u_res;
uniform float u_time;
uniform float u_scroll;
uniform float u_vel;
uniform vec3 u_a;
uniform vec3 u_b;
uniform float u_preset;
// The simulation drawn by haze (lib/fogField.ts fogTexels) or shore (lib/shoreField.ts shoreTexels).
uniform sampler2D u_sim;

const float TAU = 6.2831853;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  // Quintic easing: no visible seams along the lattice in wide, soft gradients.
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
// Each octave is rotated, so no grid direction shows through.
const mat2 OCTAVE = mat2(1.6, 1.2, -1.2, 1.6);
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = OCTAVE * p; a *= 0.5; }
  return v;
}
float fbm4(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = OCTAVE * p; a *= 0.5; }
  return v;
}

float contourHeight(vec2 p, float t) { return fbm4(p * 0.9 + vec2(t * 0.02, -t * 0.015)); }

// The beam the dust glints in; the same as lightBeam() in lib/dustField.ts.
float lightBeam(vec2 s, float aspect) {
  float d = (s.x - aspect * 0.55) * 0.55 + (s.y - 0.5) * 0.85;
  return exp(-(d * d) / 0.06);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  float aspect = u_res.x / u_res.y;
  float px = 1.0 / u_res.y;
  // The pattern moves up with the content by u_scroll (screen heights).
  vec2 p = vec2(uv.x * aspect, uv.y - u_scroll);
  float t = u_time;
  // Scroll velocity: signed, and how fast regardless of direction.
  float sv = clamp(u_vel, -3.0, 3.0);
  float av = min(abs(sv), 2.0);
  float m = 0.0;
  // Light lifted above both colours, and white foam (shore).
  float lift = 0.0;
  float white = 0.0;

  if (u_preset < 1.5) {
    // gradient: a large, slowly folding wash of the two colours.
    vec2 q = p * 0.45;
    vec2 w = vec2(noise(q + vec2(0.0, t * 0.03)), noise(q + vec2(4.7, 1.3) - t * 0.025));
    q.y += sv * 0.04;
    float n = noise(q * 0.9 + 1.1 * w) * 0.75 + noise(q * 1.8 - w) * 0.25;
    m = smoothstep(0.15, 0.85, n) * 0.8 + 0.2 * (1.0 - uv.y);
  } else if (u_preset < 2.5) {
    // waves of light: coherent light from two slowly drifting sources,
    // interfering — the intensity is |sum of the complex amplitudes|^2. The
    // sources' frequencies differ slightly, so the fringes slowly breathe; a
    // scroll sways the sources and squeezes the waves along it (Doppler).
    vec2 q = vec2(uv.x * aspect, uv.y);
    vec2 field = vec2(0.0);
    float total = 0.0;
    for (int k = 0; k < 2; k++) {
      float fk = float(k);
      // Far off the screen, so the fringes are broad and gently curved.
      vec2 src = vec2(aspect * (0.5 + 1.1 * sin(t * 0.031 * (1.0 + 0.3 * fk) + fk * 2.4)),
                      0.5 + 1.2 * cos(t * 0.027 * (1.0 + 0.2 * fk) + fk * 1.7) + 0.3 * sin(u_scroll * 0.7 + fk));
      vec2 d = q - src;
      d.y *= 1.0 + 0.08 * sv;
      float r = length(d);
      float phase = (TAU / 0.3) * r - t * (1.0 + 0.15 * fk);
      float a = 1.0 / (1.0 + r);
      field += a * vec2(cos(phase), sin(phase));
      total += a;
    }
    float intensity = dot(field, field) / (total * total);
    m = 0.08 + 0.35 * intensity + 0.1 * (1.0 - uv.y);
  } else if (u_preset < 3.5) {
    // particles: only a soft haze here; the flock is drawn over it.
    m = 0.16 * (1.0 - uv.y) + 0.12 * smoothstep(0.3, 0.8, fbm(p * 0.8 + vec2(t * 0.02, 0.0)));
  } else if (u_preset < 4.5) {
    // aurora: curtains with a bright lower edge fading upward, finely streaked.
    float sway = 0.12 * sin(p.x * 0.8 + t * 0.12) + 0.08 * sin(p.x * 1.9 - t * 0.09 + 1.3) + sv * 0.02;
    float n = fbm(vec2(p.x * 0.9 + t * 0.03, t * 0.04));
    float y = fract(p.y * 0.8 - sway - 0.15 * n) - 0.5;
    float curtain = smoothstep(-0.12, 0.0, y) * exp(-max(y, 0.0) * 6.0);
    float streak = 0.5 + 0.5 * fbm(vec2(p.x * 7.0 + n * 2.0 + t * 0.05, y * 1.5));
    m = curtain * streak * (0.9 + 0.1 * av) * 1.1 + 0.08 * (1.0 - uv.y);
  } else if (u_preset < 5.5) {
    // silk: domain-warped folds with a soft sheen running along them.
    vec2 q = p * 0.8;
    vec2 w = vec2(noise(q * 0.8 + vec2(0.0, t * 0.04)), noise(q * 0.8 + vec2(3.1, 7.4) - vec2(t * 0.035, 0.0)));
    w.y += sv * 0.03;
    float f = noise(q + 1.4 * w) * 0.7 + noise(q * 1.9 - w) * 0.3;
    float folds = 0.5 + 0.5 * sin((f * 3.5 + w.x * 0.8) * TAU + t * 0.12);
    m = smoothstep(0.2, 0.8, f) * 0.35 + pow(folds, 4.0) * 0.45 + 0.1 * (1.0 - uv.y);
  } else if (u_preset < 6.5) {
    // haze: the simulated fog, lit from above. Fog the light reaches glows;
    // fog in the shade of a denser bank stays dim, and so does the air below it.
    vec4 fog = texture2D(u_sim, vec2(uv.x, 1.0 - uv.y));
    float density = clamp(fog.r * (0.85 + 0.3 * fbm4(p * 3.0 + vec2(t * 0.06, 0.0))), 0.0, 1.0);
    float light = fog.a;
    m = 0.12 * (1.0 - uv.y) * (0.6 + 0.4 * light) + density * (0.3 + 0.7 * light);
  } else if (u_preset < 7.5) {
    // contour: hairline isolines of a slowly shifting terrain; every fifth is firmer.
    vec2 q = p + vec2(0.0, sv * 0.015);
    float h = contourHeight(q, t);
    float hx = contourHeight(q + vec2(px, 0.0), t);
    float hy = contourHeight(q + vec2(0.0, px), t);
    float slope = max(length(vec2(hx - h, hy - h)) / px, 1e-3);
    float level = h * 14.0;
    float fr = fract(level);
    float dist = min(fr, 1.0 - fr) / (14.0 * slope) / px;
    float line = 1.0 - smoothstep(0.4, 1.4, dist);
    float major = mod(floor(level + 0.5), 5.0) < 0.5 ? 0.55 : 0.28;
    m = 0.1 * h + line * major + 0.06 * (1.0 - uv.y);
  } else if (u_preset < 8.5) {
    // dust: a faint beam of light; the powder is drawn over it.
    float beam = lightBeam(vec2(uv.x * aspect, 1.0 - uv.y), aspect);
    m = 0.12 * (1.0 - uv.y) + 0.1 * beam + 0.05 * noise(p * 1.2 + vec2(t * 0.03, 0.0));
  } else if (u_preset < 9.5) {
    // shore: the simulated beach (lib/shoreField.ts), seen from above.
    vec4 beach = texture2D(u_sim, vec2(uv.x, 1.0 - uv.y));
    float depth = beach.r * beach.r;
    float foam = beach.g;
    float wet = beach.b;
    float light = beach.a * 2.0 - 1.0;
    vec2 sp = vec2(uv.x * aspect, uv.y);
    // Sand: fine grain; wet sand is darker, smoother, and its grain is drowned.
    float grain = noise(sp * 260.0) * 0.55 + noise(sp * 70.0) * 0.45;
    float sand = mix(0.05 + 0.05 * grain, 0.17 + 0.02 * grain, wet);
    // The water shows the sand through it, less the deeper it is (Beer–Lambert);
    // in the shallows its surface focuses light into caustics on the sand.
    float clear = exp(-depth * 7.0);
    float present = smoothstep(0.005, 0.05, beach.r);
    sand += 0.12 * max(light, 0.0) * present * clear;
    float sea = 0.4 + 0.42 * (1.0 - clear);
    m = mix(sand, sea, present * (1.0 - clear * 0.75));
    // The surface itself: shading from its slope and a glint where it faces the light.
    m += present * 0.1 * light;
    float glint = pow(max(light, 0.0), 3.0) * present;
    // Foam, as thick as the simulation made it: white whatever the palette, since it is
    // air in water. Thin foam lets the water show through and only thick foam is fully
    // white, so the simulation's patches and streaks keep their shading.
    white = (1.0 - exp(-foam * 1.8)) * 0.95;
    lift = clamp(glint * 0.35, 0.0, 1.0);
  } else {
    // cloth: the curtain covers this; only its edges could show.
    m = 0.1 * (1.0 - uv.y);
  }
  vec3 color = mix(u_a, u_b, clamp(m, 0.0, 1.0));
  color = mix(color, min(vec3(1.0), max(u_a, u_b) + 0.25), lift);
  color = mix(color, vec3(0.97), white);
  // A fixed sub-LSB dither, so the wide, low-contrast gradients don't band.
  color += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(color, 1.0);
}
`;

/** Points and lines (the flock, the dust): `[x, y, alpha, size]` per vertex. */
const POINTS_VERTEX = `
attribute vec2 a_xy;
attribute float a_alpha;
attribute float a_size;
uniform float u_aspect;
varying float v_alpha;
void main() {
  gl_Position = vec4(a_xy.x / u_aspect * 2.0 - 1.0, 1.0 - a_xy.y * 2.0, 0.0, 1.0);
  gl_PointSize = a_size;
  v_alpha = a_alpha;
}
`;

const POINTS_FRAGMENT = `
precision mediump float;
uniform vec3 u_color;
uniform float u_point;
varying float v_alpha;
void main() {
  float a = v_alpha;
  if (u_point > 0.5) a *= smoothstep(0.5, 0.15, length(gl_PointCoord - 0.5));
  gl_FragColor = vec4(u_color, a);
}
`;

/** A shaded mesh (the cloth): `[x, y, shade, sheen]` per vertex. */
const MESH_VERTEX = `
attribute vec2 a_xy;
attribute float a_shade;
attribute float a_sheen;
uniform float u_aspect;
varying float v_shade;
varying float v_sheen;
void main() {
  gl_Position = vec4(a_xy.x / u_aspect * 2.0 - 1.0, 1.0 - a_xy.y * 2.0, 0.0, 1.0);
  v_shade = a_shade;
  v_sheen = a_sheen;
}
`;

const MESH_FRAGMENT = `
precision mediump float;
uniform vec3 u_a;
uniform vec3 u_b;
varying float v_shade;
varying float v_sheen;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec3 fabric = mix(u_a, u_b * (0.5 + 0.6 * v_shade), 0.85);
  vec3 color = mix(fabric, min(vec3(1.0), max(u_a, u_b) + 0.25), v_sheen);
  color += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(color, 1.0);
}
`;

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** The motes' colour: colour 2 pushed a little further from colour 1, so pale pairs still read. */
function moteColor(a: string, b: string): [number, number, number] {
  const ca = rgb(a);
  const cb = rgb(b);
  return [0, 1, 2].map((i) => Math.min(1, Math.max(0, ca[i] + (cb[i] - ca[i]) * 1.6))) as [number, number, number];
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

function link(gl: WebGLRenderingContext, vertex: string, fragment: string, attributes: string[]): WebGLProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, vertex);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
  const program = vs && fs ? gl.createProgram() : null;
  if (!program || !vs || !fs) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  attributes.forEach((name, i) => gl.bindAttribLocation(program, i, name));
  gl.linkProgram(program);
  return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null;
}

const PROGRAM_SOURCES: [string, string][] = [
  [VERTEX, FRAGMENT],
  [POINTS_VERTEX, POINTS_FRAGMENT],
  [MESH_VERTEX, MESH_FRAGMENT],
];

/** Compile and link every program (by default, the renderer's own) on `gl`; the logs of what failed (empty = all good). For tests. */
export function backgroundShaderErrors(gl: WebGLRenderingContext, sources: [string, string][] = PROGRAM_SOURCES): string[] {
  const errors: string[] = [];
  for (const [vertex, fragment] of sources) {
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) errors.push(gl.getShaderInfoLog(shader) ?? "compile failed");
    }
    if (errors.length === 0 && !link(gl, vertex, fragment, [])) errors.push("link failed");
  }
  return errors;
}

interface Overlay {
  program: WebGLProgram;
  uniform: (name: string) => WebGLLocation;
}
type WebGLLocation = WebGLUniformLocation | null;

interface Programs {
  field: WebGLProgram;
  fieldU: Record<"res" | "time" | "scroll" | "vel" | "a" | "b" | "preset" | "sim", WebGLLocation>;
  quad: WebGLBuffer | null;
  /** The simulation's texture (haze, shore), and the simulation it now holds. */
  simTexture: WebGLTexture | null;
  simTextureFor: Sim | null;
  /** Vertex data of the overlays. */
  dynamic: WebGLBuffer | null;
  /** The cloth's triangles, and which cloth they were uploaded for. */
  elements: WebGLBuffer | null;
  elementsFor: Cloth | null;
  /** Null when an overlay's program doesn't build: the shader layer still draws. */
  points: Overlay | null;
  mesh: Overlay | null;
}

/**
 * Start drawing into `canvas`. `scrollY` reports the scroll offset in CSS
 * pixels (0 for a view that doesn't scroll); call `invalidate` when it changes.
 */
export function startBackground(
  canvas: HTMLCanvasElement,
  initial: BackgroundOptions,
  scrollY: () => number,
  /** Drawing-buffer pixels per device pixel (below 1 for a scaled-down view). */
  resolution = 1
): BackgroundHandle {
  let options = initial;
  let dirty = true;
  let frame = 0;
  let destroyed = false;
  let elapsed = 0;
  let last = performance.now();
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  // The scroll as drawn (screen heights, before parallax) and its velocity.
  let drawnScroll: number | null = null;
  let velocity = 0;

  let sim: Sim | null = null;
  /** Pointer in field units, its smoothed velocity, and when it last moved; null outside the canvas. */
  let pointer: { x: number; y: number; vx: number; vy: number; at: number } | null = null;

  const attributes = { antialias: false, alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: false };
  // WebGL2 when there is one: the shore simulates on the GPU only with float render targets,
  // which WebGL2 offers far more widely. Every shader here is GLSL ES 1.00, which both accept.
  const gl = (canvas.getContext("webgl2", attributes) ?? canvas.getContext("webgl", attributes)) as WebGLRenderingContext | null;
  let programs: Programs | null = null;
  /** Compile and bind everything on the context; again after it is restored. Null when WebGL can't draw. */
  function setup(g: WebGLRenderingContext): Programs | null {
    const field = link(g, VERTEX, FRAGMENT, ["a_pos"]);
    if (!field) return null;
    const quad = g.createBuffer();
    g.bindBuffer(g.ARRAY_BUFFER, quad);
    g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), g.STATIC_DRAW);
    const fu = (name: string) => g.getUniformLocation(field, name);
    const overlay = (vertex: string, fragment: string, attributes: string[]): Overlay | null => {
      const program = link(g, vertex, fragment, attributes);
      return program ? { program, uniform: (name) => g.getUniformLocation(program, name) } : null;
    };
    const simTexture = g.createTexture();
    g.bindTexture(g.TEXTURE_2D, simTexture);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    g.texImage2D(g.TEXTURE_2D, 0, g.LUMINANCE_ALPHA, 1, 1, 0, g.LUMINANCE_ALPHA, g.UNSIGNED_BYTE, new Uint8Array(2));
    g.pixelStorei(g.UNPACK_ALIGNMENT, 1);
    return {
      field,
      quad,
      fieldU: {
        res: fu("u_res"),
        time: fu("u_time"),
        scroll: fu("u_scroll"),
        vel: fu("u_vel"),
        a: fu("u_a"),
        b: fu("u_b"),
        preset: fu("u_preset"),
        sim: fu("u_sim"),
      },
      simTexture,
      simTextureFor: null,
      dynamic: g.createBuffer(),
      elements: g.createBuffer(),
      elementsFor: null,
      points: overlay(POINTS_VERTEX, POINTS_FRAGMENT, ["a_xy", "a_alpha", "a_size"]),
      mesh: overlay(MESH_VERTEX, MESH_FRAGMENT, ["a_xy", "a_shade", "a_sheen"]),
    };
  }
  if (gl) programs = setup(gl);
  const onLost = (e: Event) => {
    // Preventing the default is what lets the browser restore the context later.
    e.preventDefault();
    programs = null;
  };
  const onRestored = () => {
    if (destroyed || !gl) return;
    // A simulation's GPU state went with the context: start it again.
    disposeSim();
    programs = setup(gl);
    dirty = true;
    schedule();
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  const resize = new ResizeObserver(() => {
    dirty = true;
    schedule();
  });
  resize.observe(canvas);

  // The canvas sits behind the content, so the pointer is followed on the window.
  const onPointer = (e: PointerEvent) => {
    if (!simKind()) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.height <= 0) return;
    const x = (e.clientX - rect.left) / rect.height;
    const y = (e.clientY - rect.top) / rect.height;
    if (x < 0 || y < 0 || x > rect.width / rect.height || y > 1) {
      pointer = null;
      return;
    }
    const at = performance.now();
    let vx = 0;
    let vy = 0;
    if (pointer) {
      const dt = Math.max(1, at - pointer.at) / 1000;
      const k = Math.min(1, dt / 0.08);
      vx = pointer.vx + ((x - pointer.x) / dt - pointer.vx) * k;
      vy = pointer.vy + ((y - pointer.y) / dt - pointer.vy) * k;
    }
    const clamp = (v: number) => Math.max(-3, Math.min(3, v));
    pointer = { x, y, vx: clamp(vx), vy: clamp(vy), at };
  };
  const onPointerLeave = () => {
    pointer = null;
  };
  window.addEventListener("pointermove", onPointer, { passive: true });
  document.documentElement.addEventListener("pointerleave", onPointerLeave);

  const drawn = () => Object.hasOwn(PRESET_INDEX, options.preset);
  const simKind = (): SimKind | undefined => (Object.hasOwn(PRESET_SIM, options.preset) ? PRESET_SIM[options.preset] : undefined);
  const animating = () => drawn() && options.speed > 0 && !reduced;

  /** Ease the drawn scroll toward the real one; true while it is still moving. */
  function followScroll(dt: number, height: number): boolean {
    const target = scrollY() / Math.max(1, height);
    if (drawnScroll === null || reduced || Math.abs(target - drawnScroll) > SCROLL_SNAP) {
      drawnScroll = target;
      velocity = 0;
      return false;
    }
    const previous = drawnScroll;
    drawnScroll += (target - drawnScroll) * (1 - Math.exp(-dt / SCROLL_LAG));
    const instant = dt > 0 ? (drawnScroll - previous) / dt : 0;
    velocity += (instant - velocity) * (1 - Math.exp(-dt / VELOCITY_LAG));
    if (Math.abs(target - drawnScroll) < 1e-4 && Math.abs(velocity) < 1e-3) {
      drawnScroll = target;
      velocity = 0;
      return false;
    }
    return true;
  }

  /** The pointer as the simulations take it: fading out after it stops. */
  function pointerInput() {
    if (!pointer) return null;
    const strength = Math.max(0, 1 - (performance.now() - pointer.at) / 1000 / POINTER_LINGER);
    return strength > 0 ? { x: pointer.x, y: pointer.y, vx: pointer.vx, vy: pointer.vy, strength } : null;
  }

  /** Stop the current simulation's worker, if it has one. */
  function disposeSim() {
    if (sim?.kind === "shore") {
      if (sim.gpu) sim.gpu.destroy();
      else sim.runner.destroy();
    }
    sim = null;
  }

  /** The simulation for the current preset and screen shape, advanced by `dtSim`. */
  function advance(kind: SimKind, aspect: number, heightPx: number, scroll: number, dtSim: number): Sim {
    const regrid = sim?.kind === "shore" && sim.rows !== (sim.gpu ? shoreGpuRows(heightPx) : shoreRows(heightPx));
    if (!sim || sim.kind !== kind || regrid || Math.abs(aspect - sim.aspect) > sim.aspect * RESHAPE) {
      disposeSim();
      sim = createSim(gl!, kind, aspect, heightPx, () => {
        dirty = true;
        schedule();
      });
    }
    if (dtSim <= 0) return sim;
    const v = reduced ? 0 : velocity;
    const p = pointerInput();
    switch (sim.kind) {
      case "flock":
        stepParticles(sim.particles, { aspect, dt: dtSim, time: elapsed, scroll, velocity: v, pointer: p });
        break;
      case "dust":
        stepDust(sim.field, { aspect, dt: dtSim, scroll, velocity: v, pointer: p });
        break;
      case "fog":
        stepFog(sim.fog, { dt: dtSim, velocity: v, pointer: p });
        break;
      case "shore":
        if (sim.gpu) sim.gpu.advance({ dt: dtSim, velocity: v, pointer: p });
        else sim.runner.advance({ dt: dtSim, velocity: v, pointer: p });
        break;
      case "cloth":
        stepCloth(sim.cloth, { dt: dtSim, time: elapsed, velocity: v, pointer: p });
        break;
    }
    return sim;
  }

  function bindOverlayAttributes(g: WebGLRenderingContext) {
    const stride = 16;
    for (let i = 0; i < 3; i++) g.enableVertexAttribArray(i);
    g.vertexAttribPointer(0, 2, g.FLOAT, false, stride, 0);
    g.vertexAttribPointer(1, 1, g.FLOAT, false, stride, 8);
    g.vertexAttribPointer(2, 1, g.FLOAT, false, stride, 12);
  }

  function drawPoints(g: WebGLRenderingContext, pr: Programs, aspect: number, lines: Float32Array | null, points: Float32Array) {
    const o = pr.points;
    if (!o) return;
    g.useProgram(o.program);
    g.enable(g.BLEND);
    g.blendFuncSeparate(g.SRC_ALPHA, g.ONE_MINUS_SRC_ALPHA, g.ONE, g.ONE_MINUS_SRC_ALPHA);
    g.uniform1f(o.uniform("u_aspect"), aspect);
    g.uniform3fv(o.uniform("u_color"), moteColor(options.colorA, options.colorB));
    g.bindBuffer(g.ARRAY_BUFFER, pr.dynamic);
    if (lines && lines.length > 0) {
      g.bufferData(g.ARRAY_BUFFER, lines, g.DYNAMIC_DRAW);
      bindOverlayAttributes(g);
      g.uniform1f(o.uniform("u_point"), 0);
      g.drawArrays(g.LINES, 0, lines.length / 4);
    }
    g.bufferData(g.ARRAY_BUFFER, points, g.DYNAMIC_DRAW);
    bindOverlayAttributes(g);
    g.uniform1f(o.uniform("u_point"), 1);
    g.drawArrays(g.POINTS, 0, points.length / 4);
    g.disable(g.BLEND);
  }

  function drawCloth(g: WebGLRenderingContext, pr: Programs, aspect: number, cloth: Cloth, vertices: Float32Array) {
    const o = pr.mesh;
    if (!o) return;
    g.useProgram(o.program);
    g.uniform1f(o.uniform("u_aspect"), aspect);
    g.uniform3fv(o.uniform("u_a"), rgb(options.colorA));
    g.uniform3fv(o.uniform("u_b"), rgb(options.colorB));
    g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, pr.elements);
    if (pr.elementsFor !== cloth) {
      g.bufferData(g.ELEMENT_ARRAY_BUFFER, cloth.indices, g.STATIC_DRAW);
      pr.elementsFor = cloth;
    }
    g.bindBuffer(g.ARRAY_BUFFER, pr.dynamic);
    g.bufferData(g.ARRAY_BUFFER, vertices, g.DYNAMIC_DRAW);
    bindOverlayAttributes(g);
    g.drawElements(g.TRIANGLES, cloth.indices.length, g.UNSIGNED_SHORT, 0);
  }

  function draw(now: number) {
    frame = 0;
    if (destroyed || !programs) return;
    const dt = Math.min(now - last, 100) / 1000;
    last = now;
    if (animating()) elapsed += dt * options.speed;
    const settling = drawn() && followScroll(dt, canvas.clientHeight);
    if (!dirty && !animating() && !settling) return;
    dirty = false;
    const g = gl!;
    const pr = programs;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5) * resolution;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    g.viewport(0, 0, w, h);
    if (!drawn()) {
      g.clearColor(0, 0, 0, 0);
      g.clear(g.COLOR_BUFFER_BIT);
      if (animating() || settling) schedule();
      return;
    }
    const aspect = w / h;
    const scroll = (drawnScroll ?? 0) * options.parallax;
    const kind = simKind();
    const current = kind ? advance(kind, aspect, h, scroll, animating() ? dt * options.speed : 0) : null;
    // A GPU simulation drew into its own framebuffers.
    g.bindFramebuffer(g.FRAMEBUFFER, null);
    g.viewport(0, 0, w, h);

    if (current?.kind === "fog") {
      current.texels = fogTexels(current.fog, current.texels);
      g.activeTexture(g.TEXTURE0);
      g.bindTexture(g.TEXTURE_2D, pr.simTexture);
      g.texImage2D(g.TEXTURE_2D, 0, g.LUMINANCE_ALPHA, current.fog.nx, current.fog.ny, 0, g.LUMINANCE_ALPHA, g.UNSIGNED_BYTE, current.texels);
      pr.simTextureFor = current;
    } else if (current?.kind === "shore" && current.gpu) {
      g.activeTexture(g.TEXTURE0);
      g.bindTexture(g.TEXTURE_2D, current.gpu.texture);
      pr.simTextureFor = null;
    } else if (current?.kind === "shore") {
      const next = current.runner.take();
      if (next) {
        if (current.frame) current.runner.recycle(current.frame);
        current.frame = next;
        current.uploaded = false;
      }
      // Uploaded again after a lost context is restored (the texture went with it).
      if (current.frame && (!current.uploaded || pr.simTextureFor !== current)) {
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, pr.simTexture);
        const { nx, ny, texels } = current.frame;
        g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, nx, ny, 0, g.RGBA, g.UNSIGNED_BYTE, texels);
        current.uploaded = true;
        pr.simTextureFor = current;
      }
    }
    g.useProgram(pr.field);
    g.bindBuffer(g.ARRAY_BUFFER, pr.quad);
    g.enableVertexAttribArray(0);
    g.vertexAttribPointer(0, 2, g.FLOAT, false, 0, 0);
    const u = pr.fieldU;
    g.uniform2f(u.res, w, h);
    g.uniform1f(u.time, elapsed);
    g.uniform1f(u.scroll, scroll);
    g.uniform1f(u.vel, reduced ? 0 : velocity);
    g.uniform3fv(u.a, rgb(options.colorA));
    g.uniform3fv(u.b, rgb(options.colorB));
    g.uniform1f(u.preset, PRESET_INDEX[options.preset]);
    g.uniform1i(u.sim, 0);
    g.drawArrays(g.TRIANGLES, 0, 3);

    switch (current?.kind) {
      case "flock": {
        current.geometry = fieldGeometry(current.particles, aspect, scroll, h, current.geometry);
        const geo = current.geometry;
        drawPoints(g, pr, aspect, geo.lines.subarray(0, geo.lineVertexCount * 4), geo.points.subarray(0, geo.pointCount * 4));
        break;
      }
      case "dust":
        current.points = dustGeometry(current.field, aspect, scroll, elapsed, h, current.points);
        drawPoints(g, pr, aspect, null, current.points.subarray(0, current.field.n * 4));
        break;
      case "cloth":
        current.vertices = clothGeometry(current.cloth, current.vertices);
        drawCloth(g, pr, aspect, current.cloth, current.vertices);
        break;
    }
    for (let i = 1; i < 3; i++) g.disableVertexAttribArray(i);
    if (animating() || settling) schedule();
  }

  function schedule() {
    if (!frame && !destroyed) frame = requestAnimationFrame(draw);
  }
  schedule();

  return {
    update(next) {
      options = next;
      dirty = true;
      last = performance.now();
      schedule();
    },
    invalidate() {
      dirty = true;
      schedule();
    },
    destroy() {
      destroyed = true;
      disposeSim();
      if (frame) cancelAnimationFrame(frame);
      resize.disconnect();
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      window.removeEventListener("pointermove", onPointer);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
