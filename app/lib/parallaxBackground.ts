/**
 * The page view's animated background: one full-canvas WebGL fragment shader
 * with a few presets, two colours, a speed and a parallax factor (how far the
 * pattern follows the scroll). Framework-free, so the published page's small
 * runtime script and the editor's React views both drive it.
 *
 * - Preset `none`, a missing WebGL context, or a lost one draw nothing: the
 *   canvas stays transparent over the page's solid `--wp-bg`.
 * - `prefers-reduced-motion` freezes the animation; scrolling still moves it.
 * - Frames are only drawn when something changed (time running, scroll moved,
 *   options or size changed), so a still background costs nothing.
 */
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
};

const VERTEX = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAGMENT = `
precision mediump float;
uniform vec2 u_res;
uniform float u_time;
uniform float u_scroll;
uniform vec3 u_a;
uniform vec3 u_b;
uniform float u_preset;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.0; a *= 0.5; }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  float aspect = u_res.x / u_res.y;
  // The pattern moves up with the content by u_scroll (screen heights).
  vec2 p = vec2(uv.x * aspect, uv.y - u_scroll);
  float t = u_time;
  float m = 0.0;
  if (u_preset < 1.5) {
    m = clamp(0.5 + 0.35 * sin(p.x * 1.3 + t * 0.3) * cos(p.y * 1.7 - t * 0.2) + 0.3 * (uv.y - 0.5), 0.0, 1.0);
  } else if (u_preset < 2.5) {
    float w = sin(p.x * 3.0 + t * 0.6 + sin(p.y * 2.0 + t * 0.3) * 1.5) * 0.5 + 0.5;
    float w2 = sin(p.y * 6.0 - t * 0.4 + p.x * 1.5) * 0.5 + 0.5;
    m = smoothstep(0.25, 0.85, w * 0.6 + w2 * 0.4);
  } else if (u_preset < 3.5) {
    vec2 g = p * 7.0;
    vec2 id = floor(g);
    vec2 f = fract(g) - 0.5;
    float h = hash(id);
    vec2 o = vec2(sin(t * 0.5 + h * 6.28), cos(t * 0.4 + h * 12.0)) * 0.3;
    float r = 0.03 + 0.07 * h;
    m = smoothstep(r, r * 0.2, length(f - o)) * (0.35 + 0.65 * h) + 0.15 * uv.y;
  } else {
    float n = fbm(vec2(p.x * 1.5 + t * 0.05, p.y * 0.9 - t * 0.08));
    float curve = 0.6 + 0.2 * sin(p.x * 1.2 + t * 0.1);
    m = smoothstep(0.35, 0.75, n) * smoothstep(0.55, 0.0, abs(fract(p.y * 0.5) * 2.0 - curve));
  }
  gl_FragColor = vec4(mix(u_a, u_b, clamp(m, 0.0, 1.0)), 1.0);
}
`;

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
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

  const gl = canvas.getContext("webgl", { antialias: false, alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: false });
  type Uniforms = Record<"res" | "time" | "scroll" | "a" | "b" | "preset", WebGLUniformLocation | null>;
  let u: Uniforms | null = null;
  /** Compile and bind everything on the context; again after it is restored. Null when WebGL can't draw. */
  function setup(g: WebGLRenderingContext): Uniforms | null {
    const vs = compile(g, g.VERTEX_SHADER, VERTEX);
    const fs = compile(g, g.FRAGMENT_SHADER, FRAGMENT);
    const program = vs && fs ? g.createProgram() : null;
    if (!program || !vs || !fs) return null;
    g.attachShader(program, vs);
    g.attachShader(program, fs);
    g.linkProgram(program);
    if (!g.getProgramParameter(program, g.LINK_STATUS)) return null;
    g.useProgram(program);
    const buffer = g.createBuffer();
    g.bindBuffer(g.ARRAY_BUFFER, buffer);
    g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), g.STATIC_DRAW);
    const pos = g.getAttribLocation(program, "a_pos");
    g.enableVertexAttribArray(pos);
    g.vertexAttribPointer(pos, 2, g.FLOAT, false, 0, 0);
    const uniform = (name: string) => g.getUniformLocation(program, name);
    return {
      res: uniform("u_res"),
      time: uniform("u_time"),
      scroll: uniform("u_scroll"),
      a: uniform("u_a"),
      b: uniform("u_b"),
      preset: uniform("u_preset"),
    };
  }
  if (gl) u = setup(gl);
  const onLost = (e: Event) => {
    // Preventing the default is what lets the browser restore the context later.
    e.preventDefault();
    u = null;
  };
  const onRestored = () => {
    if (destroyed || !gl) return;
    u = setup(gl);
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

  const drawn = () => Object.hasOwn(PRESET_INDEX, options.preset);
  const animating = () => drawn() && options.speed > 0 && !reduced;

  function draw(now: number) {
    frame = 0;
    if (destroyed || !u) return;
    const dt = Math.min(now - last, 100) / 1000;
    last = now;
    if (animating()) elapsed += dt * options.speed;
    if (!dirty && !animating()) return;
    dirty = false;
    const g = gl!;
    const loc = u;
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
    } else {
      g.uniform2f(loc.res, w, h);
      g.uniform1f(loc.time, elapsed);
      g.uniform1f(loc.scroll, (scrollY() / Math.max(1, canvas.clientHeight)) * options.parallax);
      g.uniform3fv(loc.a, rgb(options.colorA));
      g.uniform3fv(loc.b, rgb(options.colorB));
      g.uniform1f(loc.preset, PRESET_INDEX[options.preset]);
      g.drawArrays(g.TRIANGLES, 0, 3);
    }
    if (animating()) schedule();
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
      if (frame) cancelAnimationFrame(frame);
      resize.disconnect();
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
