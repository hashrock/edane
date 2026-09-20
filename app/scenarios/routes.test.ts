/**
 * ハンドラを DB なしで叩く例：`resolve` が固定ユーザーを返すモック AuthProvider を
 * `authMiddleware` に渡すだけで、Hono の `app.request` でそのまま検証できる。
 * （データを作る `run` 経路は D1 が要るので、ここでは判断とレスポンスの形だけ。）
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../global.d";
import type { SessionUser } from "../user";
import { authMiddleware, type AuthProvider } from "../auth/provider";
import { scenarioRoutes } from "./index";

const alice: SessionUser = { id: "alice", email: "alice@example.com", name: "Alice", avatarUrl: "" };

export function mockAuth(user: SessionUser | null, kind: AuthProvider["kind"] = "session"): AuthProvider {
  return { kind, resolve: async () => user, signIn: vi.fn(async () => {}), signOut: vi.fn(async () => {}) };
}

function appWith(auth: AuthProvider) {
  const app = new Hono<Env>();
  app.use("*", authMiddleware(() => auth));
  app.route("/__scenarios", scenarioRoutes());
  return app;
}

const env = {} as Env["Bindings"];

describe("scenario routes with a mock AuthProvider", () => {
  it("lists scenarios and shows who is signed in", async () => {
    const res = await appWith(mockAuth(alice)).request("/__scenarios", {}, env);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Alice");
    for (const name of ["empty", "typical", "large", "trash", "public", "site"]) {
      expect(body).toContain(`/__scenarios/${name}?format=json`);
    }
  });

  it("returns 404 for an unknown scenario (HTML and JSON)", async () => {
    const app = appWith(mockAuth(alice));
    expect((await app.request("/__scenarios/nope", {}, env)).status).toBe(404);
    const json = await app.request("/__scenarios/nope?format=json", {}, env);
    expect(json.status).toBe(404);
    expect(await json.json()).toMatchObject({ error: "unknown-scenario" });
  });

  it("sends a signed-out visitor to the list page (HTML) or 401 (JSON) under session auth", async () => {
    const app = appWith(mockAuth(null));
    const html = await app.request("/__scenarios/typical", {}, env);
    expect(html.status).toBe(303);
    expect(html.headers.get("Location")).toBe("/__scenarios?reason=login-required&scenario=typical");
    const json = await app.request("/__scenarios/typical", { headers: { Accept: "application/json" } }, env);
    expect(json.status).toBe(401);
    expect(await json.json()).toMatchObject({ error: "login-required", loginUrl: "/auth/google" });
  });

  it("never calls signIn under session auth", async () => {
    const auth = mockAuth(alice);
    await appWith(auth).request("/__scenarios", {}, env);
    await appWith(auth).request("/__scenarios/nope", {}, env);
    expect(auth.signIn).not.toHaveBeenCalled();
  });
});
