/**
 * AuthProvider の契約：
 * - `selectAuth` は DEV_BYPASS_AUTH のときだけ bypass を選ぶ
 * - 本番（sessionAuth）は impersonate Cookie を完全に無視する
 * - bypassAuth は guest → impersonate → Dev User の順で解決し、signIn / signOut が
 *   以後のリクエストの resolve を変える
 * DB は触らない（Dev User の解決はスタブ、Bearer トークンは送らない）。
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { Env } from "../global.d";
import type { SessionUser } from "../user";
import { authMiddleware, type AuthProvider } from "./provider";
import { selectAuth } from "./index";
import { sessionAuth } from "./sessionAuth";
import { bypassAuth, DEV_USER, IMPERSONATE_COOKIE } from "./bypassAuth";

const env = { SESSION_SECRET: "test-secret" } as Env["Bindings"];
const bob: SessionUser = { id: "bob", email: "bob@example.com", name: "Bob 🙂", avatarUrl: "" };

/** whoami + signin/signout endpoints on top of a provider, so cookies round-trip like a browser. */
function harness(auth: AuthProvider) {
  const app = new Hono<Env>();
  app.use("*", authMiddleware(() => auth));
  app.get("/whoami", (c) => c.json({ user: c.get("user"), kind: c.get("auth").kind }));
  app.post("/signin", async (c) => {
    await c.get("auth").signIn(c, bob);
    return c.text("ok");
  });
  app.post("/signout", async (c) => {
    await c.get("auth").signOut(c);
    return c.text("ok");
  });
  return app;
}

/** Fold Set-Cookie headers into a Cookie header the way a browser would (drops Max-Age=0). */
function cookieJar(jar: string, res: Response): string {
  const pairs = new Map(jar.split("; ").filter(Boolean).map((kv) => kv.split("=") as [string, string]));
  for (const line of res.headers.getSetCookie()) {
    const [kv, ...attrs] = line.split(";").map((s) => s.trim());
    const [name, value] = kv.split("=");
    if (attrs.some((a) => /^max-age=0$/i.test(a))) pairs.delete(name);
    else pairs.set(name, value);
  }
  return [...pairs].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function whoami(app: Hono<Env>, cookie: string) {
  const res = await app.request("/whoami", { headers: cookie ? { Cookie: cookie } : {} }, env);
  return (await res.json()) as { user: SessionUser | null; kind: string };
}

const noDb = bypassAuth({ devUser: async () => DEV_USER });

describe("selectAuth", () => {
  it("picks the bypass only when DEV_BYPASS_AUTH is set", () => {
    expect(selectAuth({ DEV_BYPASS_AUTH: "true" }).kind).toBe("bypass");
    expect(selectAuth({ DEV_BYPASS_AUTH: undefined }).kind).toBe("session");
    expect(selectAuth({}).kind).toBe("session");
  });
});

describe("bypassAuth", () => {
  it("resolves the Dev User by default, the impersonated user after signIn, and Dev User again after signOut", async () => {
    const app = harness(noDb);
    expect((await whoami(app, "")).user).toEqual(DEV_USER);

    const signin = await app.request("/signin", { method: "POST" }, env);
    const jar = cookieJar("", signin);
    expect(jar).toContain(`${IMPERSONATE_COOKIE}=`);
    expect((await whoami(app, jar)).user).toEqual(bob);

    const signout = await app.request("/signout", { method: "POST", headers: { Cookie: jar } }, env);
    expect((await whoami(app, cookieJar(jar, signout))).user).toEqual(DEV_USER);
  });

  it("ignores a tampered impersonate cookie", async () => {
    const app = harness(noDb);
    const signin = await app.request("/signin", { method: "POST" }, env);
    const jar = cookieJar("", signin).replace(/=([^;]+)$/, "=$1x");
    expect((await whoami(app, jar)).user).toEqual(DEV_USER);
  });

  it("keeps the ?guest=1 toggle (signed out) and signIn leaves guest mode", async () => {
    const app = harness(noDb);
    const guest = await app.request("/whoami?guest=1", {}, env);
    let jar = cookieJar("", guest);
    expect(((await guest.json()) as { user: unknown }).user).toBeNull();
    expect((await whoami(app, jar)).user).toBeNull();

    const signin = await app.request("/signin", { method: "POST", headers: { Cookie: jar } }, env);
    jar = cookieJar(jar, signin);
    expect(jar).not.toContain("dev_guest");
    expect((await whoami(app, jar)).user).toEqual(bob);
  });
});

describe("sessionAuth (production)", () => {
  it("completely ignores the impersonate cookie, even a validly signed one", async () => {
    const signin = await harness(noDb).request("/signin", { method: "POST" }, env);
    const jar = cookieJar("", signin);
    expect(jar).toContain(`${IMPERSONATE_COOKIE}=`);
    const prod = harness(sessionAuth);
    expect((await whoami(prod, jar)).user).toBeNull();
    expect((await whoami(prod, "")).user).toBeNull();
  });

  it("signIn writes the session cookie, which resolves on the next request and clears on signOut", async () => {
    const app = harness(sessionAuth);
    const signin = await app.request("/signin", { method: "POST" }, env);
    const jar = cookieJar("", signin);
    expect(jar).toMatch(/^session=/);
    expect((await whoami(app, jar)).user).toEqual(bob);
    const signout = await app.request("/signout", { method: "POST", headers: { Cookie: jar } }, env);
    expect((await whoami(app, cookieJar(jar, signout))).user).toBeNull();
  });

  it("never treats the bypass cookies as a session under a different secret either", async () => {
    const signin = await harness(noDb).request("/signin", { method: "POST" }, env);
    const jar = cookieJar("", signin);
    const res = await harness(sessionAuth).request("/whoami", { headers: { Cookie: jar } }, {
      SESSION_SECRET: "other",
    } as Env["Bindings"]);
    expect(((await res.json()) as { user: unknown }).user).toBeNull();
  });
});
