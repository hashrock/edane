/**
 * The 404 page. Hono's default `c.notFound()` is a bare "404 Not Found" text
 * — a user who opened a stale or someone else's note link saw only that, with
 * no way back into the app (usertest #13). This renders a small self-contained
 * HTML page (no Inertia / client bundle needed, so it works for any path) with
 * a plain-language explanation and a link to the note list.
 *
 * API and data-feed paths keep a JSON body so clients don't have to parse
 * HTML out of an error (`wantsJsonNotFound`).
 */

import { MESSAGES_JA } from "./messages";

/** API / feed routes answer 404 as JSON; everything else gets the HTML page. */
export function wantsJsonNotFound(pathname: string, accept: string | undefined): boolean {
  if (pathname.startsWith("/api/")) return true;
  if (/^\/pub\/[^/]+\.(json|md)$/.test(pathname)) return true;
  if (accept && accept.includes("application/json") && !accept.includes("text/html")) return true;
  return false;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The page markup. The server has no per-user locale (it is a localStorage
 * preference on the client), so this uses the Japanese catalog, matching the
 * `<html lang="ja">` document shell.
 */
export function notFoundHtml(
  messages: { notFoundTitle: string; notFoundMessage: string; notFoundBackToList: string } = MESSAGES_JA
): string {
  const title = escapeHtml(messages.notFoundTitle);
  const body = escapeHtml(messages.notFoundMessage);
  const back = escapeHtml(messages.notFoundBackToList);
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — Edane</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #f8fafc; color: #0f172a; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { max-width: 28rem; padding: 2rem 1.5rem; }
  h1 { font-size: 1.25rem; margin: 0 0 0.75rem; }
  p { margin: 0 0 1.5rem; line-height: 1.7; color: #475569; font-size: 0.95rem; }
  a { display: inline-block; padding: 0.6rem 1.1rem; border-radius: 0.75rem; background: #059669; color: #fff;
      text-decoration: none; font-weight: 600; font-size: 0.9rem; }
  a:hover { background: #047857; }
  code { color: #94a3b8; font-size: 0.8rem; }
</style>
</head>
<body>
<main>
  <h1>${title}</h1>
  <p>${body}</p>
  <a href="/notes">${back}</a>
  <p style="margin-top:1.5rem"><code>404 Not Found</code></p>
</main>
</body>
</html>
`;
}
