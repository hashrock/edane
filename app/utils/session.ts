import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context } from "hono";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string;
};

const SESSION_COOKIE = "session";

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
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
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

  const sig = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0));
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    sig,
    new TextEncoder().encode(payload)
  );

  return valid ? payload : null;
}

export async function setSession(c: Context, user: SessionUser) {
  const payload = btoa(JSON.stringify(user));
  const token = await sign(payload, c.env.SESSION_SECRET);
  const isLocalhost = new URL(c.req.url).hostname === "localhost";
  setCookie(c, SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    secure: !isLocalhost,
    sameSite: "Lax",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function getSession(c: Context): Promise<SessionUser | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;

  try {
    const payload = await verify(token, c.env.SESSION_SECRET);
    if (!payload) return null;
    return JSON.parse(atob(payload)) as SessionUser;
  } catch {
    return null;
  }
}

export function clearSession(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}
