/**
 * The shore simulation (lib/shoreField.ts) on the GPU: the same shallow water
 * model, run as fragment-shader passes over float textures, so the beach can
 * be divided far more finely than the CPU can afford.
 *
 * State, one texel per cell (row 0 = the top of the screen), ping-ponged:
 * - water:   h, u (the face left of the cell), v (the face above it), breaking
 * - surface: foam, wetness, h at the start of the frame, foam persistence
 * - limit:   each cell's flux limiter (scratch)
 * - bed:     the ground (static, uploaded from the CPU model)
 *
 * Each sub-step: momentum → flux limiter → continuity (+ the wave maker).
 * Each frame: breaking/infiltration → foam/wetness → display, which writes the
 * RGBA8 texture the background shader draws (the same channels as
 * shoreTexels). Nothing is read back to the CPU.
 *
 * One deliberate difference from the CPU version: within a sub-step, the y
 * momentum sees the x velocities from before the step, not after (every
 * fragment of a pass reads the same input). Foam is advected before its
 * sources are added rather than after. Both are within the scheme's own error.
 *
 * Needs float render targets (WebGL2 + EXT_color_buffer_float, or WebGL1 +
 * OES_texture_float with a renderable float framebuffer); {@link startShoreGpu}
 * returns null without them and the caller falls back to the CPU.
 */
import { createShore, SHORE_CONSTANTS as K, spongeRows, type Shore, type ShoreStep } from "./shoreField";

export interface ShoreGpu {
  readonly rows: number;
  readonly nx: number;
  readonly ny: number;
  /** The drawable RGBA8 texture (LINEAR), refreshed by every advance. */
  readonly texture: WebGLTexture;
  /** Let `step.dt` seconds pass. Leaves the default framebuffer bound; the caller resets its viewport. */
  advance(step: ShoreStep): void;
  /** The water state (h, u, v, breaking per cell), for tests. */
  readWater(): Float32Array;
  destroy(): void;
}

/** How finely to divide the beach on the GPU for a drawing buffer this many pixels high. */
export function shoreGpuRows(heightPx: number): number {
  return Math.max(64, Math.min(512, Math.round(heightPx / 2)));
}

/** A bound on |velocity| + wave speed (the momentum pass clamps velocities to keep it). */
const SPEED_BOUND = 0.5;
const MAX_VELOCITY = 0.35;
const MAX_SUBSTEPS = 16;

const f = (n: number) => {
  const s = String(n);
  return /[.eE]/.test(s) ? s : `${s}.0`;
};

const VERTEX = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const COMMON = `
precision highp float;
uniform sampler2D u_water;
uniform sampler2D u_bed;
uniform vec2 u_size;
uniform float u_dx;
const float GRAVITY = ${f(K.GRAVITY)};
const float DRY = ${f(K.DRY)};
const float FRICTION = ${f(K.FRICTION)};
const float FRICTION_DEPTH = ${f(K.FRICTION_DEPTH)};
const float BREAK_VISCOSITY = ${f(K.BREAK_VISCOSITY)};
const float MAX_VELOCITY = ${f(MAX_VELOCITY)};
vec2 texel(float i, float j) { return (vec2(mod(i, u_size.x), clamp(j, 0.0, u_size.y - 1.0)) + 0.5) / u_size; }
vec4 W(float i, float j) { return texture2D(u_water, texel(i, j)); }
float B(float i, float j) { return texture2D(u_bed, texel(i, j)).r; }
// v on the face below cell (i, j): the land wall below the last row.
float vBelow(float i, float j) { return j + 1.0 < u_size.y ? W(i, j + 1.0).b : 0.0; }
`;

const MOMENTUM = `${COMMON}
uniform float u_dt;
uniform float u_slosh;
uniform vec4 u_pointer;
uniform float u_pull;
void main() {
  vec2 c = floor(gl_FragCoord.xy);
  float i = c.x;
  float j = c.y;
  float idx = 1.0 / u_dx;
  float pressure = GRAVITY * u_dt * idx;
  float carry = u_dt * idx;
  float viscous = u_dt * BREAK_VISCOSITY * idx * idx;
  vec4 here = W(i, j);

  // x face between (i - 1, j) and (i, j)
  vec4 west = W(i - 1.0, j);
  float hl = west.r;
  float hr = here.r;
  float bl = B(i - 1.0, j);
  float br = B(i, j);
  float el = bl + hl;
  float er = br + hr;
  float u = 0.0;
  if (!((hl < DRY && (hr < DRY || bl > er)) || (hr < DRY && br > el))) {
    float uk = here.g;
    float uw = west.g;
    float ue = W(i + 1.0, j).g;
    float dudx = uk > 0.0 ? uk - uw : ue - uk;
    float vc = 0.25 * (here.b + west.b + vBelow(i, j) + vBelow(i - 1.0, j));
    float un = j > 0.0 ? W(i, j - 1.0).g : uk;
    float us = j < u_size.y - 1.0 ? W(i, j + 1.0).g : uk;
    float dudy = vc > 0.0 ? uk - un : us - uk;
    u = uk - pressure * (er - el) - carry * (uk * dudx + vc * dudy);
    float b = max(here.a, west.a);
    u += viscous * b * (uw + ue + un + us - 4.0 * uk);
    float depth = max(0.5 * (hl + hr), FRICTION_DEPTH);
    u /= 1.0 + u_dt * FRICTION * sqrt(u * u + vc * vc) / depth;
  }

  // y face between (i, j - 1) and (i, j); row 0's face belongs to the wave maker.
  float v = here.b;
  if (j >= 1.0) {
    vec4 north = W(i, j - 1.0);
    float ha = north.r;
    float hb = here.r;
    float ba = B(i, j - 1.0);
    float bb = br;
    float ea = ba + ha;
    float eb = bb + hb;
    if ((ha < DRY && (hb < DRY || ba > eb)) || (hb < DRY && bb > ea)) {
      v = 0.0;
    } else {
      float vk = here.b;
      float vn = north.b;
      float vs = vBelow(i, j);
      float dvdy = vk > 0.0 ? vk - vn : vs - vk;
      float uc = 0.25 * (here.g + W(i + 1.0, j).g + north.g + W(i + 1.0, j - 1.0).g);
      float vw = west.b;
      float ve = W(i + 1.0, j).b;
      float dvdx = uc > 0.0 ? vk - vw : ve - vk;
      v = vk - pressure * (eb - ea) - carry * (vk * dvdy + uc * dvdx) + u_slosh;
      float b = max(here.a, north.a);
      v += viscous * b * (vw + ve + vn + vs - 4.0 * vk);
      float depth = max(0.5 * (ha + hb), FRICTION_DEPTH);
      v /= 1.0 + u_dt * FRICTION * sqrt(v * v + uc * uc) / depth;
    }
  }

  // The pointer drags the water it passes through.
  if (u_pull > 0.0 && here.r >= DRY) {
    vec2 d = (c + 0.5) * u_dx - u_pointer.xy;
    float w = exp(-dot(d, d) / 0.0015) * u_pull;
    u += (u_pointer.z * 0.3 - u) * w;
    v += (u_pointer.w * 0.3 - v) * w;
  }
  gl_FragColor = vec4(here.r, clamp(u, -MAX_VELOCITY, MAX_VELOCITY), clamp(v, -MAX_VELOCITY, MAX_VELOCITY), here.a);
}
`;

/** Upwind fluxes through a cell's four faces (west, east, north, south), unlimited. */
const FLUXES = `
vec4 fluxes(float i, float j) {
  vec4 here = W(i, j);
  float h = here.r;
  float uw = here.g;
  float fw = uw * (uw > 0.0 ? W(i - 1.0, j).r : h);
  vec4 east = W(i + 1.0, j);
  float fe = east.g * (east.g > 0.0 ? h : east.r);
  float fn = j > 0.0 ? here.b * (here.b > 0.0 ? W(i, j - 1.0).r : h) : 0.0;
  float fs = 0.0;
  if (j + 1.0 < u_size.y) {
    vec4 south = W(i, j + 1.0);
    fs = south.b * (south.b > 0.0 ? h : south.r);
  }
  return vec4(fw, fe, fn, fs);
}
`;

const LIMITER = `${COMMON}${FLUXES}
uniform float u_dt;
void main() {
  vec2 c = floor(gl_FragCoord.xy);
  vec4 fl = fluxes(c.x, c.y);
  float h = W(c.x, c.y).r;
  float need = (max(-fl.x, 0.0) + max(fl.y, 0.0) + max(-fl.z, 0.0) + max(fl.w, 0.0)) * u_dt / u_dx;
  gl_FragColor = vec4(need > h ? h / need : 1.0, 0.0, 0.0, 0.0);
}
`;

const CONTINUITY = `${COMMON}${FLUXES}
uniform sampler2D u_limit;
uniform float u_dt;
uniform float u_time;
uniform float u_spongeRows;
uniform vec4 u_waves[3];
uniform vec3 u_amps;
float L(float i, float j) { return texture2D(u_limit, texel(i, j)).r; }
void main() {
  vec2 c = floor(gl_FragCoord.xy);
  float i = c.x;
  float j = c.y;
  vec4 here = W(i, j);
  vec4 fl = fluxes(i, j);
  float lh = L(i, j);
  float fw = fl.x * (fl.x > 0.0 ? L(i - 1.0, j) : lh);
  float fe = fl.y * (fl.y > 0.0 ? lh : L(i + 1.0, j));
  float fn = fl.z * (fl.z > 0.0 ? L(i, j - 1.0) : lh);
  float fs = fl.w * (fl.w > 0.0 ? lh : L(i, j + 1.0));
  float h = max(0.0, here.r - u_dt / u_dx * (fe - fw + fs - fn));
  float u = here.g;
  float v = here.b;

  // The wave maker: relax the top rows toward the incoming waves (and absorb what comes back).
  if (j < u_spongeRows) {
    float pull = min(1.0, u_dt * 6.0 * pow((u_spongeRows - j) / u_spongeRows, 2.0));
    float eta = 0.0;
    float ui = 0.0;
    float vi = 0.0;
    for (int k = 0; k < 3; k++) {
      vec4 w = u_waves[k];
      float amp = k == 0 ? u_amps.x : k == 1 ? u_amps.y : u_amps.z;
      // Linear shallow-water waves: velocity = g k eta / omega, along k.
      eta += amp * cos(w.x * (i + 0.5) * u_dx + w.y * (j + 0.5) * u_dx - w.z * u_time + w.w);
      ui += GRAVITY * w.x / w.z * amp * cos(w.x * i * u_dx + w.y * (j + 0.5) * u_dx - w.z * u_time + w.w);
      vi += GRAVITY * w.y / w.z * amp * cos(w.x * (i + 0.5) * u_dx + w.y * j * u_dx - w.z * u_time + w.w);
    }
    h += (max(0.0, eta - B(i, j)) - h) * pull;
    u += (ui - u) * pull;
    if (j > 0.0) v += (vi - v) * pull;
  }
  gl_FragColor = vec4(h, u, v, here.a);
}
`;

const BREAKING = `${COMMON}
uniform sampler2D u_surface;
uniform float u_dt;
const float INFILTRATION = ${f(K.INFILTRATION)};
const float BREAK_ONSET = ${f(K.BREAK_ONSET)};
const float BREAK_FULL = ${f(K.BREAK_FULL)};
void main() {
  vec2 c = floor(gl_FragCoord.xy);
  vec4 here = W(c.x, c.y);
  vec4 surf = texture2D(u_surface, texel(c.x, c.y));
  float h = here.r;
  if (h > 0.0 && h < 0.004) h = max(0.0, h - u_dt * INFILTRATION * (1.0 - 0.8 * surf.g));
  float ratio = (h - surf.b) / u_dt / sqrt(GRAVITY * max(h, 0.001));
  float target = h < DRY ? 0.0 : clamp((ratio - BREAK_ONSET) / (BREAK_FULL - BREAK_ONSET), 0.0, 1.0);
  // A breaker keeps breaking for a moment after its front has passed.
  gl_FragColor = vec4(h, here.g, here.b, max(target, here.a * exp(-u_dt / 0.4)));
}
`;

const FOAM = `${COMMON}
uniform sampler2D u_surface;
uniform float u_dt;
uniform float u_epoch;
const float FOAM_BREAKING = ${f(K.FOAM_BREAKING)};
const float FOAM_FRONT = ${f(K.FOAM_FRONT)};
const float FOAM_LIFE_WATER = ${f(K.FOAM_LIFE_WATER)};
const float FOAM_LIFE_SAND = ${f(K.FOAM_LIFE_SAND)};
const float FOAM_GATHER = ${f(K.FOAM_GATHER)};
const float DRY_TIME = ${f(K.DRY_TIME)};
const float FOAM_PATCH = ${f(K.FOAM_PATCH)};
vec4 surfAt(float i, float j) { return texture2D(u_surface, texel(i, j)); }
float hash2(vec2 p) { return fract(sin(p.x * 127.1 + p.y * 311.7) * 43758.5453); }
// The persistence fresh foam gets here (value noise; freshPersistence in lib/shoreField.ts).
float freshPersistence(vec2 at) {
  vec2 g = at / FOAM_PATCH + u_epoch * vec2(17.3, 5.1);
  vec2 c = floor(g);
  vec2 t = g - c;
  vec2 e = t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
  return mix(mix(hash2(c), hash2(c + vec2(1.0, 0.0)), e.x), mix(hash2(c + vec2(0.0, 1.0)), hash2(c + vec2(1.0, 1.0)), e.x), e.y);
}
float lifeScale(float persist) { return 0.3 + 1.6 * persist * persist; }
void main() {
  vec2 c = floor(gl_FragCoord.xy);
  float i = c.x;
  float j = c.y;
  vec4 here = W(i, j);
  vec4 surf = texture2D(u_surface, texel(i, j));
  float h = here.r;
  float ue = W(i + 1.0, j).g;
  float vs = vBelow(i, j);
  float foam = surf.r;
  float wet = surf.g;
  float persist = surf.a;
  if (h >= DRY) {
    float idx = 1.0 / u_dx;
    float uc = 0.5 * (here.g + ue);
    float vc = 0.5 * (here.b + vs);
    // Foam, and how long it lasts, ride the surface flow (semi-Lagrangian, bilinear).
    vec2 back = vec2(i - uc * u_dt * idx, clamp(j - vc * u_dt * idx, 0.0, u_size.y - 1.0));
    vec2 b0 = floor(back);
    vec2 s = back - b0;
    vec4 carried = mix(mix(surfAt(b0.x, b0.y), surfAt(b0.x + 1.0, b0.y), s.x),
                       mix(surfAt(b0.x, b0.y + 1.0), surfAt(b0.x + 1.0, b0.y + 1.0), s.x), s.y);
    foam = carried.r;
    persist = carried.a;
    float speed = sqrt(uc * uc + vc * vc);
    float front = h < 0.004 ? max(0.0, speed - 0.06) : 0.0;
    // Carried foam is squeezed together where the flow converges, spread thin where it diverges.
    float divergence = (ue - here.g + vs - here.b) * idx;
    float added = u_dt * (FOAM_BREAKING * here.a + FOAM_FRONT * front);
    if (added > 0.0) persist = (foam * persist + added * freshPersistence((c + 0.5) * u_dx)) / (foam + added);
    foam = (foam + added) * exp(-u_dt / (FOAM_LIFE_WATER * lifeScale(persist)) - FOAM_GATHER * divergence * u_dt);
    wet = 1.0;
  } else {
    foam *= exp(-u_dt / (FOAM_LIFE_SAND * lifeScale(persist)));
    wet *= exp(-u_dt / DRY_TIME);
  }
  gl_FragColor = vec4(min(foam, 1.5), wet, h, persist);
}
`;

const DISPLAY = `${COMMON}
uniform sampler2D u_surface;
const float DEPTH_SCALE = ${f(K.DEPTH_SCALE)};
const float SLOPE_GAIN = ${f(K.SLOPE_GAIN)};
const float CURVATURE_GAIN = ${f(K.CURVATURE_GAIN)};
const vec2 LIGHT = vec2(${f(K.LIGHT_X)}, ${f(K.LIGHT_Y)});
float S(float i, float j) { return B(i, j) + W(i, j).r; }
void main() {
  vec2 c = floor(gl_FragCoord.xy);
  float i = c.x;
  float j = c.y;
  float h = W(i, j).r;
  vec4 surf = texture2D(u_surface, texel(i, j));
  float light = 0.5;
  if (h >= DRY) {
    // Sobel: the slope over the 3×3 neighbourhood, so a bore crossing the
    // grid at an angle shades as a smooth front, not a staircase.
    float gx = (S(i + 1.0, j - 1.0) + 2.0 * S(i + 1.0, j) + S(i + 1.0, j + 1.0)
              - S(i - 1.0, j - 1.0) - 2.0 * S(i - 1.0, j) - S(i - 1.0, j + 1.0)) / (8.0 * u_dx);
    float gy = (S(i - 1.0, j + 1.0) + 2.0 * S(i, j + 1.0) + S(i + 1.0, j + 1.0)
              - S(i - 1.0, j - 1.0) - 2.0 * S(i, j - 1.0) - S(i + 1.0, j - 1.0)) / (8.0 * u_dx);
    // Without the beach's own slope where the film is thin: only the waves catch the light.
    float bx = (B(i + 1.0, j) - B(i - 1.0, j)) / (2.0 * u_dx);
    float by = (B(i, j + 1.0) - B(i, j - 1.0)) / (2.0 * u_dx);
    float deep = min(1.0, h / 0.004);
    float facing = -dot(vec2(gx - bx * (1.0 - deep), gy - by * (1.0 - deep)), LIGHT) * SLOPE_GAIN;
    float s0 = S(i, j);
    float curvature = (S(i + 1.0, j) + S(i - 1.0, j) + S(i, j + 1.0) + S(i, j - 1.0) - 4.0 * s0) / (u_dx * u_dx);
    light = 0.5 + 0.5 * clamp(facing - curvature * CURVATURE_GAIN, -1.0, 1.0);
  }
  gl_FragColor = vec4(sqrt(min(1.0, h / DEPTH_SCALE)), min(1.0, surf.r), surf.g, light);
}
`;

/** Every program the GPU shore builds, for the shader compile test. */
export const SHORE_GPU_SOURCES: [string, string][] = [MOMENTUM, LIMITER, CONTINUITY, BREAKING, FOAM, DISPLAY].map((fs) => [
  VERTEX,
  fs,
]);

interface Target {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
}

interface Pass {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
}

function isWebGL2(gl: WebGLRenderingContext): gl is WebGLRenderingContext & WebGL2RenderingContext {
  return typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

/**
 * Build the beach on `gl` and settle it for `settle` seconds. Null when this
 * context can't render to float textures (or a shader fails to build).
 */
export function startShoreGpu(gl: WebGLRenderingContext, aspect: number, rows: number, settle = 0.5): ShoreGpu | null {
  const webgl2 = isWebGL2(gl);
  if (webgl2 ? !gl.getExtension("EXT_color_buffer_float") : !gl.getExtension("OES_texture_float")) return null;
  if (!webgl2) gl.getExtension("WEBGL_color_buffer_float");

  // The CPU model lays out the ground and the starting water; the GPU takes it from there.
  const seed: Shore = createShore(aspect, rows, 0);
  const { nx, ny, dx } = seed;
  const size = nx * ny;

  const created: { textures: WebGLTexture[]; framebuffers: WebGLFramebuffer[]; programs: WebGLProgram[] } = {
    textures: [],
    framebuffers: [],
    programs: [],
  };
  const release = () => {
    created.framebuffers.forEach((fb) => gl.deleteFramebuffer(fb));
    created.textures.forEach((t) => gl.deleteTexture(t));
    created.programs.forEach((p) => gl.deleteProgram(p));
  };

  const floatTexture = (data: Float32Array | null): WebGLTexture => {
    const texture = gl.createTexture()!;
    created.textures.push(texture);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const internal = webgl2 ? (gl as WebGL2RenderingContext).RGBA32F : gl.RGBA;
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, nx, ny, 0, gl.RGBA, gl.FLOAT, data);
    return texture;
  };
  const target = (texture: WebGLTexture): Target | null => {
    const framebuffer = gl.createFramebuffer()!;
    created.framebuffers.push(framebuffer);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return ok ? { texture, framebuffer } : null;
  };

  const pack = (a: ArrayLike<number>, b: ArrayLike<number>, c: ArrayLike<number>, d: ArrayLike<number> | null) => {
    const out = new Float32Array(size * 4);
    for (let k = 0; k < size; k++) {
      out[k * 4] = a[k];
      out[k * 4 + 1] = b[k];
      out[k * 4 + 2] = c[k];
      out[k * 4 + 3] = d ? d[k] : 0;
    }
    return out;
  };
  const water = [target(floatTexture(pack(seed.h, seed.u, seed.v, seed.breaking))), target(floatTexture(null))];
  const surface = [target(floatTexture(pack(seed.foam, seed.wet, seed.h, seed.persist))), target(floatTexture(null))];
  const limit = target(floatTexture(null));
  const bed = floatTexture(pack(seed.bed, seed.bed, seed.bed, null));

  const display = gl.createTexture()!;
  created.textures.push(display);
  gl.bindTexture(gl.TEXTURE_2D, display);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, nx, ny, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const displayTarget = target(display);

  const build = (fragment: string): Pass | null => {
    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
    if (!vs || !fs) return null;
    const program = gl.createProgram()!;
    created.programs.push(program);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, "a_pos");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
    return { program, uniforms: new Map() };
  };
  const momentum = build(MOMENTUM);
  const limiter = build(LIMITER);
  const continuity = build(CONTINUITY);
  const breaking = build(BREAKING);
  const foam = build(FOAM);
  const show = build(DISPLAY);

  const [w0, w1] = water;
  const [s0, s1] = surface;
  if (!w0 || !w1 || !s0 || !s1 || !limit || !displayTarget || !momentum || !limiter || !continuity || !breaking || !foam || !show) {
    release();
    return null;
  }
  const waters: Target[] = [w0, w1];
  const surfaces: Target[] = [s0, s1];
  let wi = 0;
  let si = 0;

  const quad = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

  const wavesUniform = new Float32Array(12);
  const amps = new Float32Array(3);
  seed.waves.slice(0, 3).forEach((w, k) => {
    wavesUniform.set([w.kx, w.ky, w.omega, w.phase], k * 4);
    amps[k] = w.amp;
  });
  const sponge = spongeRows(ny);

  let time = 0;
  let lastVelocity = 0;

  const run = (pass: Pass, into: Target, inputs: Record<string, WebGLTexture>, set: (u: (name: string) => WebGLUniformLocation | null) => void) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, into.framebuffer);
    gl.viewport(0, 0, nx, ny);
    gl.useProgram(pass.program);
    const u = (name: string) => {
      if (!pass.uniforms.has(name)) pass.uniforms.set(name, gl.getUniformLocation(pass.program, name));
      return pass.uniforms.get(name)!;
    };
    let unit = 0;
    for (const [name, texture] of Object.entries(inputs)) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(u(name), unit);
      unit++;
    }
    gl.uniform2f(u("u_size"), nx, ny);
    gl.uniform1f(u("u_dx"), dx);
    set(u);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  function step(dtFrame: number, velocity: number, pointer: ShoreStep["pointer"]) {
    gl.disable(gl.BLEND);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    if (dtFrame > 0) {
      const accel = Math.max(-20, Math.min(20, (velocity - lastVelocity) / dtFrame));
      lastVelocity = velocity;
      const limitStep = (K.CFL * dx) / SPEED_BOUND;
      let total = Math.min(dtFrame, 0.1);
      let n = Math.ceil(total / limitStep);
      if (n > MAX_SUBSTEPS) {
        n = MAX_SUBSTEPS;
        total = n * limitStep;
      }
      const dt = total / n;
      const live = pointer && pointer.strength > 0 ? pointer : null;
      for (let s = 0; s < n; s++) {
        run(momentum!, waters[1 - wi], { u_water: waters[wi].texture, u_bed: bed }, (u) => {
          gl.uniform1f(u("u_dt"), dt);
          gl.uniform1f(u("u_slosh"), dt * K.SLOSH * accel);
          gl.uniform4f(u("u_pointer"), live?.x ?? 0, live?.y ?? 0, live?.vx ?? 0, live?.vy ?? 0);
          gl.uniform1f(u("u_pull"), s === 0 && live ? live.strength * Math.min(1, 8 * total) : 0);
        });
        wi = 1 - wi;
        run(limiter!, limit!, { u_water: waters[wi].texture, u_bed: bed }, (u) => gl.uniform1f(u("u_dt"), dt));
        run(continuity!, waters[1 - wi], { u_water: waters[wi].texture, u_bed: bed, u_limit: limit!.texture }, (u) => {
          gl.uniform1f(u("u_dt"), dt);
          gl.uniform1f(u("u_time"), time);
          gl.uniform1f(u("u_spongeRows"), sponge);
          gl.uniform4fv(u("u_waves[0]"), wavesUniform);
          gl.uniform3fv(u("u_amps"), amps);
        });
        wi = 1 - wi;
        time += dt;
      }
      run(breaking!, waters[1 - wi], { u_water: waters[wi].texture, u_bed: bed, u_surface: surfaces[si].texture }, (u) =>
        gl.uniform1f(u("u_dt"), total)
      );
      wi = 1 - wi;
      run(foam!, surfaces[1 - si], { u_water: waters[wi].texture, u_bed: bed, u_surface: surfaces[si].texture }, (u) => {
        gl.uniform1f(u("u_dt"), total);
        gl.uniform1f(u("u_epoch"), Math.floor(time * K.FOAM_PATCH_RATE));
      });
      si = 1 - si;
    }
    run(show!, displayTarget!, { u_water: waters[wi].texture, u_bed: bed, u_surface: surfaces[si].texture }, () => {});
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  for (let t = 0; t < settle; t += 1 / 30) step(1 / 30, 0, null);
  step(0, 0, null);

  return {
    rows,
    nx,
    ny,
    texture: display,
    advance(s) {
      step(s.dt, s.velocity, s.pointer);
    },
    readWater() {
      const out = new Float32Array(size * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, waters[wi].framebuffer);
      gl.readPixels(0, 0, nx, ny, gl.RGBA, gl.FLOAT, out);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return out;
    },
    destroy() {
      release();
      gl.deleteBuffer(quad);
    },
  };
}
