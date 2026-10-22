import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context } from "hono";
import type { SessionUser } from "../user";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, gt, lte } from "drizzle-orm";
import { sessions } from "../db/schema";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToBase64Url,
  decodeBase64Utf8,
  encodeBase64Utf8,
} from "./base64";

async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload)
  );
  const sigB64 = bytesToBase64(new Uint8Array(sig));
  return `${payload}.${sigB64}`;
}

async function verify(
  token: string,
  secret: string
): Promise<string | null> {
  const lastDot = token.lastIndexOf(".");
  if (lastDot === -1) return null;

  const payload = token.substring(0, lastDot);
  const sigB64 = token.substring(lastDot + 1);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const sig = base64ToBytes(sigB64);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    sig,
    new TextEncoder().encode(payload)
  );

  return valid ? payload : null;
}

/** Whether cookies for this request get `Secure` (everything but local dev on http://localhost). */
const isSecureRequest = (c: Context) => new URL(c.req.url).hostname !== "localhost";

/**
 * A value in an HMAC-signed cookie (SESSION_SECRET). The session cookie and the
 * dev-bypass impersonation cookie (auth/bypassAuth.ts) share the format under
 * different names, so neither can be read as the other.
 */
export async function writeSignedCookie(c: Context, name: string, value: unknown, maxAge: number) {
  // UTF-8 first: a non-Latin1 display name would make a raw btoa() throw.
  const payload = encodeBase64Utf8(JSON.stringify(value));
  const token = await sign(payload, c.env.SESSION_SECRET);
  setCookie(c, name, token, {
    path: "/",
    httpOnly: true,
    secure: isSecureRequest(c),
    sameSite: "Lax",
    maxAge,
  });
}

export async function readSignedCookie<T>(c: Context, name: string): Promise<T | null> {
  const token = getCookie(c, name);
  if (!token) return null;
  try {
    const payload = await verify(token, c.env.SESSION_SECRET);
    if (!payload) return null;
    return JSON.parse(decodeBase64Utf8(payload)) as T;
  } catch {
    return null;
  }
}

/** How long a browser sign-in lasts. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * `__Host-` keeps a sibling subdomain from setting or overwriting the cookie
 * (it needs Secure and Path=/, no Domain). Local dev is plain http, so it keeps
 * the bare name there.
 */
const sessionCookieName = (c: Context) => (isSecureRequest(c) ? "__Host-session" : "session");
/** The cookie before server-side sessions: never read, deleted on sign-out. */
const LEGACY_SESSION_COOKIE = "session";

type SessionCookie = { sid: string; user: SessionUser };

/** Start a server-side session (one row) and point the cookie at it. Expired rows are swept here. */
export async function setSession(c: Context, user: SessionUser) {
  const now = Date.now();
  const sid = randomSessionId();
  const db = drizzle(c.env.DB);
  await db.batch([
    db.delete(sessions).where(lte(sessions.expiresAt, now)),
    db.insert(sessions).values({ id: sid, userId: user.id, expiresAt: now + SESSION_TTL_MS }),
  ]);
  await writeSignedCookie(c, sessionCookieName(c), { sid, user } satisfies SessionCookie, SESSION_TTL_MS / 1000);
}

/** The signed-in user and their session row, if the cookie names a live row. One indexed read. */
export async function getSession(c: Context): Promise<{ user: SessionUser; sid: string } | null> {
  const cookie = await readSignedCookie<Partial<SessionCookie>>(c, sessionCookieName(c));
  if (!cookie?.sid || !cookie.user) return null;
  const row = await drizzle(c.env.DB)
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, cookie.sid), gt(sessions.expiresAt, Date.now())))
    .get();
  return row ? { user: cookie.user, sid: cookie.sid } : null;
}

/** End the session server-side (the row) and in the browser (the cookie). */
export async function clearSession(c: Context) {
  const cookie = await readSignedCookie<Partial<SessionCookie>>(c, sessionCookieName(c));
  if (cookie?.sid) await drizzle(c.env.DB).delete(sessions).where(eq(sessions.id, cookie.sid));
  deleteCookie(c, sessionCookieName(c), { path: "/", secure: isSecureRequest(c) });
  deleteCookie(c, LEGACY_SESSION_COOKIE, { path: "/" });
}

function randomSessionId(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}
