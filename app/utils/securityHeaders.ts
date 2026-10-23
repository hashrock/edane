/**
 * Baseline security headers on every response (#217). A route that needs a
 * stricter policy sets its own Content-Security-Policy and keeps it: the
 * raw images (sandboxed), the OAuth consent page (no framing at all).
 *
 * - `frame-ancestors 'self'`: no other site can frame the app to trick a click
 *   (the landing page embeds /guest, which is same-origin).
 * - `script-src`: our own bundle plus the hashrock service switcher. Its
 *   `v1.js` is re-published in place (5-minute cache), so it can't carry an
 *   SRI hash; the allowlist at least keeps every other origin out.
 * - `object-src 'none'`, `base-uri 'self'`: no plugins, no <base> hijack.
 */
import type { MiddlewareHandler } from "hono";

export const BASELINE_CSP = [
  "frame-ancestors 'self'",
  "script-src 'self' https://repos.hashrock.info",
  "object-src 'none'",
  "base-uri 'self'",
].join("; ");

const BASELINE: Record<string, string> = {
  "Content-Security-Policy": BASELINE_CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  // A WebSocket upgrade (101) carries no document.
  if (c.res.status === 101) return;
  const missing = Object.entries(BASELINE).filter(([name]) => !c.res.headers.has(name));
  if (missing.length === 0) return;
  // A Response passed through from fetch() has immutable headers; copy it first.
  try {
    for (const [name, value] of missing) c.res.headers.set(name, value);
  } catch {
    c.res = new Response(c.res.body, c.res);
    for (const [name, value] of missing) c.res.headers.set(name, value);
  }
};
