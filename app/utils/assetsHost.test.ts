import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { Env } from "../global.d";
import { assetsHostGate, imageUrl, onAssetsHost, resolveAssetsOrigin } from "./assetsHost";

const ASSETS = "https://edane-assets.hashrock.info";
const APP = "https://edane.hashrock.info";

describe("resolveAssetsOrigin", () => {
  it("is off in dev builds and when unset", () => {
    expect(resolveAssetsOrigin(ASSETS, true)).toBeNull();
    expect(resolveAssetsOrigin(undefined, false)).toBeNull();
    expect(resolveAssetsOrigin("", false)).toBeNull();
  });

  it("normalizes to the origin", () => {
    expect(resolveAssetsOrigin(`${ASSETS}/`, false)).toBe(ASSETS);
  });
});

describe("imageUrl / onAssetsHost", () => {
  it("is absolute on the assets host, relative without one", () => {
    expect(imageUrl("abc", ASSETS)).toBe(`${ASSETS}/api/images/abc/raw`);
    expect(imageUrl("abc", null)).toBe("/api/images/abc/raw");
  });

  it("tells the hosts apart", () => {
    expect(onAssetsHost(`${ASSETS}/api/images/abc/raw`, ASSETS)).toBe(true);
    expect(onAssetsHost(`${APP}/api/images/abc/raw`, ASSETS)).toBe(false);
    expect(onAssetsHost(`${ASSETS}/api/images/abc/raw`, null)).toBe(false);
  });
});

describe("assetsHostGate", () => {
  function harness(origin: string | null) {
    const app = new Hono<Env>();
    app.use("*", assetsHostGate(() => origin));
    app.get("/api/images/:id/raw", (c) => c.text("image"));
    app.get("/api/images", (c) => c.text("list"));
    app.get("/", (c) => c.text("app"));
    app.post("/api/notes", (c) => c.text("saved"));
    return app;
  }

  it("serves only the image route on the assets host", async () => {
    const app = harness(ASSETS);
    expect(await (await app.request(`${ASSETS}/api/images/abc/raw`)).text()).toBe("image");
    for (const path of ["/", "/api/images", "/api/images/abc/raw/x"]) {
      expect((await app.request(`${ASSETS}${path}`)).status).toBe(404);
    }
    expect((await app.request(`${ASSETS}/api/notes`, { method: "POST" })).status).toBe(404);
  });

  it("leaves the app host alone", async () => {
    const app = harness(ASSETS);
    expect(await (await app.request(`${APP}/`)).text()).toBe("app");
    expect(await (await app.request(`${APP}/api/images`)).text()).toBe("list");
  });

  it("does nothing without an assets origin", async () => {
    const app = harness(null);
    expect(await (await app.request(`${ASSETS}/`)).text()).toBe("app");
  });
});
