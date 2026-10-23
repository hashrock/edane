import { expect, it } from "vitest";
import { backgroundShaderErrors } from "./parallaxBackground";
import { createShore, stepShore } from "./shoreField";
import { SHORE_GPU_SOURCES, startShoreGpu } from "./shoreGpu";

it("compiles and links the background shaders on real WebGL", () => {
  const gl = document.createElement("canvas").getContext("webgl");
  expect(gl).not.toBeNull();
  expect(backgroundShaderErrors(gl!)).toEqual([]);
});

it("compiles the GPU shore's passes", () => {
  const gl = document.createElement("canvas").getContext("webgl2") as WebGLRenderingContext | null;
  expect(gl).not.toBeNull();
  expect(backgroundShaderErrors(gl!, SHORE_GPU_SOURCES)).toEqual([]);
});

it("runs the same beach on the GPU as on the CPU", () => {
  const gl = document.createElement("canvas").getContext("webgl2") as WebGLRenderingContext | null;
  const gpu = gl && startShoreGpu(gl, 1.6, 64, 0);
  expect(gpu).not.toBeNull();
  const cpu = createShore(1.6, 64, 0);
  for (let f = 0; f < 60; f++) {
    gpu!.advance({ dt: 1 / 60, velocity: 0, pointer: null });
    stepShore(cpu, { dt: 1 / 60, velocity: 0, pointer: null });
  }
  const water = gpu!.readWater();
  let massGpu = 0;
  let massCpu = 0;
  let diff = 0;
  for (let k = 0; k < cpu.nx * cpu.ny; k++) {
    expect(Number.isFinite(water[k * 4])).toBe(true);
    massGpu += water[k * 4];
    massCpu += cpu.h[k];
    diff += Math.abs(water[k * 4] - cpu.h[k]);
  }
  // Same water, and nearly the same surface (the schemes differ only in update order).
  expect(Math.abs(massGpu - massCpu) / massCpu).toBeLessThan(0.01);
  expect(diff / massCpu).toBeLessThan(0.03);
  gpu!.destroy();
});
