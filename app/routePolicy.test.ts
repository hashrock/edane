/**
 * The route policy table (auth/routePolicy.ts) and the routes the app
 * registers must match exactly: a new route without a policy, or a policy
 * left behind by a removed route, fails here.
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { Env } from "./global.d";
import app from "./server";
import { ROUTE_POLICY, requireRouteUser, routePolicyMiddleware, type RoutePolicy } from "./auth/routePolicy";

describe("ROUTE_POLICY covers every route", () => {
  const registered = new Set(app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`));

  it("every registered route has a policy", () => {
    const missing = [...registered].filter((k) => !(k in ROUTE_POLICY));
    expect(missing).toEqual([]);
  });

  it("every policy belongs to a registered route", () => {
    const stale = Object.keys(ROUTE_POLICY).filter((k) => !registered.has(k));
    expect(stale).toEqual([]);
  });
});

describe("routePolicyMiddleware", () => {
  const ORIGIN = "http://edane.test";
  const user = { id: "u", email: "u@example.com", name: "U", avatarUrl: "" };
  const table: Record<string, RoutePolicy> = {
    "GET /pub": { access: "public" },
    "POST /pub": { access: "public" },
    "GET /notes": { access: "user" },
    "POST /notes": { access: "user", maxBody: 10 },
    "GET /page": { access: "user-page" },
    "POST /tokens": { access: "browser-user" },
    "GET /preview": { access: "anonymous", rateLimit: "LINK_PREVIEW_LIMITER" },
  };
  function harness(signedIn: boolean, allowed = () => true) {
    const a = new Hono<Env>();
    a.use("*", routePolicyMiddleware(table));
    a.use("*", async (c, next) => {
      c.set("user", signedIn ? user : null);
      await next();
    });
    a.use("*", requireRouteUser);
    for (const key of [...Object.keys(table), "GET /unlisted"]) {
      const [method, path] = key.split(" ");
      a.on(method, path, async (c) => c.text(method === "POST" ? `ok ${(await c.req.text()).length}` : "ok"));
    }
    const env = { LINK_PREVIEW_LIMITER: { limit: async () => ({ success: allowed() }) } } as unknown as Env["Bindings"];
    return (path: string, init: RequestInit = {}) => a.request(`${ORIGIN}${path}`, init, env);
  }
  const post = (body = "{}", headers: Record<string, string> = { Origin: ORIGIN }) => ({ method: "POST", body, headers });

  it("refuses a route that has no policy (fail closed)", async () => {
    expect((await harness(true)("/unlisted")).status).toBe(403);
  });

  it("refuses a cookie-borne unsafe request from another origin, even on public routes", async () => {
    const req = harness(true);
    expect((await req("/pub", post("{}", { Origin: "https://evil.example" }))).status).toBe(403);
    expect((await req("/notes", post("{}", { Origin: "https://sibling.hashrock.info" }))).status).toBe(403);
    expect((await req("/notes", post("{}", {}))).status).toBe(403);
    expect((await req("/notes", post("{}", { "Sec-Fetch-Site": "same-origin" }))).status).toBe(200);
    expect((await req("/notes", post()))).toHaveProperty("status", 200);
  });

  it("lets a Bearer request skip the origin check, but not reach browser-only routes", async () => {
    const req = harness(true);
    expect((await req("/notes", post("{}", { Authorization: "Bearer t" }))).status).toBe(200);
    expect((await req("/tokens", post("{}", { Authorization: "Bearer t" }))).status).toBe(403);
    expect((await req("/tokens", post())).status).toBe(200);
  });

  it("answers guests by access level", async () => {
    const req = harness(false);
    expect((await req("/pub")).status).toBe(200);
    expect((await req("/notes")).status).toBe(401);
    expect((await req("/tokens", post())).status).toBe(401);
    const page = await req("/page");
    expect(page.status).toBe(302);
    expect(page.headers.get("Location")).toBe("/");
  });

  it("refuses a WebSocket upgrade from another origin (cross-site WebSocket hijacking)", async () => {
    const req = harness(true);
    const upgrade = (origin: string) => req("/notes", { headers: { Upgrade: "websocket", Origin: origin } });
    expect((await upgrade("https://evil.example")).status).toBe(403);
    expect((await upgrade(ORIGIN)).status).toBe(200);
  });

  it("applies the route's per-IP rate limit", async () => {
    expect((await harness(false)("/preview")).status).toBe(200);
    const limited = await harness(false, () => false)("/preview");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
  });

  it("caps the body per route", async () => {
    const req = harness(true);
    expect((await req("/notes", post("x".repeat(10)))).status).toBe(200);
    expect((await req("/notes", post("x".repeat(11)))).status).toBe(413);
  });
});
