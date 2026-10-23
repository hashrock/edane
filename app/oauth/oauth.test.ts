/**
 * OAuth の経路の契約: 登録 → 同意画面 → コード → トークン → リフレッシュ → 解除。
 * 行はメモリ上の OAuthStore に置く（D1 は通らない）。ログイン中のユーザーは
 * ミドルウェアで差し込み、同意画面は Inertia の JSON 応答（X-Inertia）で中身を見る。
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { inertia } from "@hono/inertia";
import type { Env } from "../global.d";
import type { SessionUser } from "../user";
import { oauthServerRoutes, oauthSessionRoutes } from "./index";
import { requireRouteUser, routePolicyMiddleware } from "../auth/routePolicy";
import type { OAuthClient, OAuthCode, OAuthGrant, OAuthStore } from "./store";
import { REFRESH_TOKEN_TTL_MS } from "./protocol";
import { hashToken } from "../utils/tokenHash";

const ORIGIN = "http://edane.test";
const REDIRECT = "https://client.example/cb";
const VERIFIER = "a".repeat(20) + "-verifier-" + "b".repeat(20);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const ALICE: SessionUser = { id: "alice", email: "alice@example.com", name: "Alice", avatarUrl: "" };

function memoryStore() {
  const clients = new Map<string, OAuthClient & { createdAt: number; authorizedAt: number | null }>();
  const codes = new Map<string, OAuthCode>();
  const grants = new Map<string, OAuthGrant & { createdAt: string; previousRefreshHash?: string }>();
  const store: OAuthStore = {
    async createClient(c, { now, unauthorizedClientsBefore }) {
      for (const [k, code] of codes) if (code.expiresAt <= now) codes.delete(k);
      for (const [k, g] of grants) if (g.refreshExpiresAt <= now) grants.delete(k);
      for (const [k, cl] of clients) if (cl.authorizedAt === null && cl.createdAt < unauthorizedClientsBefore) clients.delete(k);
      clients.set(c.id, { ...c, createdAt: now, authorizedAt: null });
    },
    async findClient(id) {
      return clients.get(id) ?? null;
    },
    async saveCode(c) {
      codes.set(c.codeHash, c);
    },
    async takeCode(h) {
      const c = codes.get(h) ?? null;
      codes.delete(h);
      return c;
    },
    async createGrant(g, now) {
      grants.set(g.id, { ...g, createdAt: "t0" });
      clients.get(g.clientId)!.authorizedAt ??= now;
    },
    async rotateGrant(refreshHash, clientId, next, now) {
      for (const g of grants.values()) {
        if (g.refreshTokenHash === refreshHash && g.clientId === clientId && g.refreshExpiresAt > now) {
          Object.assign(g, next, { previousRefreshHash: refreshHash });
          return { scope: g.scope };
        }
      }
      return null;
    },
    async revokeOnRefreshReuse(refreshHash, clientId) {
      for (const [k, g] of grants) {
        if (g.previousRefreshHash === refreshHash && g.clientId === clientId) return grants.delete(k);
      }
      return false;
    },
    async listGrants(userId, now) {
      return [...grants.values()]
        .filter((g) => g.userId === userId && g.refreshExpiresAt > now)
        .map((g) => ({ id: g.id, clientName: clients.get(g.clientId)!.name, createdAt: g.createdAt }));
    },
    async deleteGrant(userId, id) {
      const g = grants.get(id);
      if (!g || g.userId !== userId) return false;
      grants.delete(id);
      return true;
    },
  };
  return { store, clients, codes, grants };
}

function setup(user: SessionUser | null = ALICE) {
  const mem = memoryStore();
  let now = 1_000_000;
  let registrationAllowed = true;
  const deps = { store: () => mem.store, now: () => now, allowRegistration: async () => registrationAllowed };
  // Same order as server.ts: the route policy (CSRF etc.) first, the user, then the guest check.
  const app = new Hono<Env>()
    .use("*", routePolicyMiddleware())
    .route("/", oauthServerRoutes(deps))
    .use("*", async (c, next) => {
      c.set("user", user);
      await next();
    })
    .use("*", requireRouteUser)
    .use(inertia())
    .route("/", oauthSessionRoutes(deps));
  const req = (path: string, init?: RequestInit) => app.request(`${ORIGIN}${path}`, init);
  return {
    ...mem,
    req,
    advance: (ms: number) => (now += ms),
    limitRegistration: () => {
      registrationAllowed = false;
    },
  };
}

const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
  body: new URLSearchParams(fields).toString(),
});

async function register(t: ReturnType<typeof setup>, extra: Record<string, unknown> = {}) {
  const res = await t.req("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [REDIRECT], ...extra }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { client_id: string; client_secret?: string; token_endpoint_auth_method: string };
}

const authorizeParams = (clientId: string) => ({
  response_type: "code",
  client_id: clientId,
  redirect_uri: REDIRECT,
  code_challenge: CHALLENGE,
  code_challenge_method: "S256",
  state: "st",
  resource: `${ORIGIN}/mcp`,
});

/** 同意画面で「許可」を押し、戻り先に付いたコードを返す。 */
async function approve(t: ReturnType<typeof setup>, clientId: string) {
  const res = await t.req("/oauth/authorize", form({ ...authorizeParams(clientId), scope: "notes", decision: "approve" }));
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get("Location")!);
  expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
  expect(loc.searchParams.get("state")).toBe("st");
  expect(loc.searchParams.get("iss")).toBe(ORIGIN);
  return loc.searchParams.get("code")!;
}

const exchange = (t: ReturnType<typeof setup>, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  t.req("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });

describe("discovery", () => {
  it("serves protected resource and authorization server metadata", async () => {
    const t = setup();
    const prm = await (await t.req("/.well-known/oauth-protected-resource/mcp")).json();
    expect(prm).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
    const as = await (await t.req("/.well-known/oauth-authorization-server")).json();
    expect(as).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
    });
  });
});

describe("authorization code flow", () => {
  it("register → consent → code → tokens → refresh", async () => {
    const t = setup();
    const { client_id } = await register(t);

    const page = await t.req(`/oauth/authorize?${new URLSearchParams(authorizeParams(client_id))}`, {
      headers: { "X-Inertia": "true" },
    });
    expect(page.status).toBe(200);
    expect(page.headers.get("X-Frame-Options")).toBe("DENY");
    const { component, props } = (await page.json()) as { component: string; props: Record<string, unknown> };
    expect(component).toBe("OAuth/Authorize");
    expect(props).toMatchObject({ clientName: "ChatGPT", redirectTo: "https://client.example" });
    expect(props.fields).toMatchObject({ client_id, redirect_uri: REDIRECT, code_challenge: CHALLENGE, scope: "notes" });

    const code = await approve(t, client_id);
    const res = await exchange(t, { grant_type: "authorization_code", code, client_id, redirect_uri: REDIRECT, code_verifier: VERIFIER });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const tokens = (await res.json()) as { access_token: string; refresh_token: string; token_type: string; expires_in: number };
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "notes" });
    expect(tokens.access_token).toMatch(/^edane_oat_/);

    // 保存されるのはハッシュだけ。
    const [grant] = [...t.grants.values()];
    expect(grant).toMatchObject({ userId: "alice", clientId: client_id, accessTokenHash: await hashToken(tokens.access_token) });

    // コードは使い切り。
    const again = await exchange(t, { grant_type: "authorization_code", code, client_id, code_verifier: VERIFIER });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: "invalid_grant" });

    // リフレッシュで両方入れ替わり、古いリフレッシュトークンは使えなくなる。
    const refreshed = await exchange(t, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { access_token: string; refresh_token: string };
    expect(next.access_token).not.toBe(tokens.access_token);
    expect(grant.accessTokenHash).toBe(await hashToken(next.access_token));
    const replay = await exchange(t, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id });
    expect(replay.status).toBe(400);
    // Replaying a rotated refresh token means it leaked: the whole grant goes, the current pair too.
    expect(t.grants.size).toBe(0);
    const afterReuse = await exchange(t, { grant_type: "refresh_token", refresh_token: next.refresh_token, client_id });
    expect(afterReuse.status).toBe(400);
  });

  it("rejects a wrong PKCE verifier, an expired code and another client's code", async () => {
    const t = setup();
    const { client_id } = await register(t);
    const other = await register(t);

    const bad = await exchange(t, { grant_type: "authorization_code", code: await approve(t, client_id), client_id, code_verifier: "x".repeat(43) });
    expect(await bad.json()).toMatchObject({ error: "invalid_grant", error_description: "PKCE verification failed" });

    const code = await approve(t, client_id);
    t.advance(10 * 60 * 1000);
    const expired = await exchange(t, { grant_type: "authorization_code", code, client_id, code_verifier: VERIFIER });
    expect(await expired.json()).toMatchObject({ error: "invalid_grant" });

    const stolen = await exchange(t, { grant_type: "authorization_code", code: await approve(t, client_id), client_id: other.client_id, code_verifier: VERIFIER });
    expect(await stolen.json()).toMatchObject({ error: "invalid_grant" });
    expect(t.grants.size).toBe(0);
  });

  it("requires the secret of a confidential client (Basic or post)", async () => {
    const t = setup();
    const { client_id, client_secret } = await register(t, { token_endpoint_auth_method: "client_secret_basic" });
    expect(client_secret).toMatch(/^edane_ocs_/);

    const missing = await exchange(t, { grant_type: "authorization_code", code: await approve(t, client_id), client_id, code_verifier: VERIFIER });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ error: "invalid_client" });

    const basic = `Basic ${btoa(`${client_id}:${client_secret}`)}`;
    const ok = await exchange(t, { grant_type: "authorization_code", code: await approve(t, client_id), code_verifier: VERIFIER }, { Authorization: basic });
    expect(ok.status).toBe(200);

    const post = await exchange(t, {
      grant_type: "authorization_code",
      code: await approve(t, client_id),
      client_id,
      client_secret: client_secret!,
      code_verifier: VERIFIER,
    });
    expect(post.status).toBe(200);
  });

  it("refreshing stops working after the refresh token expires", async () => {
    const t = setup();
    const { client_id } = await register(t);
    const code = await approve(t, client_id);
    const { refresh_token } = (await (await exchange(t, { grant_type: "authorization_code", code, client_id, code_verifier: VERIFIER })).json()) as { refresh_token: string };
    t.advance(90 * 24 * 60 * 60 * 1000);
    const res = await exchange(t, { grant_type: "refresh_token", refresh_token, client_id });
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
  });
});

describe("consent page", () => {
  it("sends a signed-out user to Google and remembers where to come back", async () => {
    const t = setup(null);
    const { client_id } = await register(t);
    const res = await t.req(`/oauth/authorize?${new URLSearchParams(authorizeParams(client_id))}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/google");
    expect(res.headers.get("Set-Cookie")).toMatch(/^__Host-oauth_return=%2Foauth%2Fauthorize%3F.*; Path=\/; .*Secure/);
  });

  it("never redirects to an unregistered redirect_uri", async () => {
    const t = setup();
    const { client_id } = await register(t);
    const res = await t.req(`/oauth/authorize?${new URLSearchParams({ ...authorizeParams(client_id), redirect_uri: "https://evil.example/cb" })}`);
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
  });

  it("returns protocol errors to the client's redirect", async () => {
    const t = setup();
    const { client_id } = await register(t);
    const res = await t.req(`/oauth/authorize?${new URLSearchParams({ ...authorizeParams(client_id), code_challenge_method: "plain" })}`);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.searchParams.get("error")).toBe("invalid_request");
    expect(loc.searchParams.get("state")).toBe("st");
  });

  it("deny returns access_denied and issues nothing", async () => {
    const t = setup();
    const { client_id } = await register(t);
    const res = await t.req("/oauth/authorize", form({ ...authorizeParams(client_id), decision: "deny" }));
    expect(new URL(res.headers.get("Location")!).searchParams.get("error")).toBe("access_denied");
    expect(t.codes.size).toBe(0);
  });

  it("refuses a cross-origin approval", async () => {
    const t = setup();
    const { client_id } = await register(t);
    const init = form({ ...authorizeParams(client_id), decision: "approve" });
    const res = await t.req("/oauth/authorize", { ...init, headers: { ...init.headers, Origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    expect(t.codes.size).toBe(0);
  });
});

describe("connected apps", () => {
  it("lists and revokes the user's grants only", async () => {
    const t = setup();
    const { client_id } = await register(t);
    await exchange(t, { grant_type: "authorization_code", code: await approve(t, client_id), client_id, code_verifier: VERIFIER });
    const list = (await (await t.req("/api/oauth/grants")).json()) as { id: string; clientName: string }[];
    expect(list).toEqual([{ id: expect.any(String), clientName: "ChatGPT", createdAt: "t0" }]);

    const bob = setup({ ...ALICE, id: "bob" });
    expect((await bob.req(`/api/oauth/grants/${list[0].id}`, { method: "DELETE", headers: { Origin: ORIGIN } })).status).toBe(404);

    expect((await t.req(`/api/oauth/grants/${list[0].id}`, { method: "DELETE", headers: { Origin: ORIGIN } })).status).toBe(200);
    expect(t.grants.size).toBe(0);
  });
});

describe("housekeeping", () => {
  it("rate-limits dynamic client registration", async () => {
    const t = setup();
    t.limitRegistration();
    const res = await t.req("/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT] }),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(t.clients.size).toBe(0);
  });

  it("purges expired codes and grants and never-authorized clients, keeping authorized ones", async () => {
    const t = setup();
    const authorized = await register(t);
    const abandoned = await register(t);
    await exchange(t, { grant_type: "authorization_code", code: await approve(t, authorized.client_id), client_id: authorized.client_id, code_verifier: VERIFIER });
    await approve(t, authorized.client_id); // never exchanged

    t.advance(REFRESH_TOKEN_TTL_MS);
    // The grant is past its refresh token: hidden at once, deleted by the next registration.
    expect(await (await t.req("/api/oauth/grants")).json()).toEqual([]);
    await register(t);

    expect(t.codes.size).toBe(0);
    expect(t.grants.size).toBe(0);
    expect(t.clients.has(abandoned.client_id)).toBe(false);
    // Reconnecting with the same client still works after its grant is gone.
    expect(t.clients.has(authorized.client_id)).toBe(true);
  });
});
