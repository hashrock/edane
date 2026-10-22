/**
 * Every route's access policy in one table, enforced by one middleware.
 *
 * Handlers used to hand-roll who may call them, CSRF, body size and error
 * detail, and each review found a route that forgot one. Now a route that is
 * not in {@link ROUTE_POLICY} is refused (fail closed), and
 * app/routePolicy.test.ts checks that the table and the registered routes
 * match exactly, so adding a route without deciding its policy fails CI.
 *
 * Access levels:
 * - `public`: anyone, guests included.
 * - `user`: signed in, by browser session or API token (Bearer). API tokens
 *   are scoped to notes (ADR 0005), so only note routes use this.
 * - `user-page`: a signed-in page; a guest is sent to the landing page.
 * - `browser`: no `Authorization` header (the handler decides about guests).
 * - `browser-user`: signed in by the browser session, never by an API token.
 *   Credential management and the other web-app-only APIs: a leaked token
 *   must not mint more tokens or reach beyond notes.
 * - `self`: mounted before the session middleware and authenticates itself
 *   (Bearer / OAuth / stats token); this middleware never sees it.
 *
 * Cross-cutting rules for every non-`self` route:
 * - CSRF: an unsafe method without `Authorization` (that is, one a browser
 *   could send with our cookie) must come from our own origin. SameSite=Lax
 *   alone lets sibling subdomains of the same site through.
 * - Body size: {@link DEFAULT_MAX_BODY} unless the route says otherwise.
 */
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { matchedRoutes } from "hono/route";
import type { Env } from "../global.d";

export type Access = "public" | "user" | "user-page" | "browser" | "browser-user" | "self";

export interface RoutePolicy {
  access: Access;
  /** Request body limit in bytes (default {@link DEFAULT_MAX_BODY}). */
  maxBody?: number;
}

export const DEFAULT_MAX_BODY = 1024 * 1024;

const MiB = 1024 * 1024;

/** `"<METHOD> <path pattern>"` → policy, for every route the app registers. */
export const ROUTE_POLICY = {
  // Mounted before the session middleware (authenticate themselves).
  "GET /api/stats": { access: "self" },
  "POST /mcp": { access: "self" },
  "GET /mcp": { access: "self" },
  "DELETE /mcp": { access: "self" },
  "GET /.well-known/oauth-protected-resource/mcp": { access: "self" },
  "GET /.well-known/oauth-protected-resource": { access: "self" },
  "GET /.well-known/oauth-authorization-server": { access: "self" },
  "POST /oauth/register": { access: "self" },
  "POST /oauth/token": { access: "self" },

  // OAuth consent and connected apps.
  "GET /oauth/authorize": { access: "browser" },
  "POST /oauth/authorize": { access: "browser-user" },
  "GET /api/oauth/grants": { access: "browser-user" },
  "DELETE /api/oauth/grants/:id": { access: "browser-user" },

  // Sign-in.
  "GET /auth/google": { access: "public" },
  "POST /auth/logout": { access: "public" },

  // Notes (the API token scope).
  "GET /api/notes/:id/sync": { access: "user" },
  // A full replace carries the whole note (commits are capped at 1 MB) plus JSON quoting.
  "PUT /api/notes/:id": { access: "user", maxBody: 2 * MiB },
  "POST /notes": { access: "user" },
  "POST /notes/:id/trash": { access: "user" },
  "POST /notes/:id/restore": { access: "user" },
  "DELETE /notes/:id": { access: "user" },
  "POST /notes/:id/pin": { access: "user" },

  // API tokens.
  "POST /api/tokens": { access: "browser-user" },
  "GET /api/tokens": { access: "browser-user" },
  "DELETE /api/tokens/:id": { access: "browser-user" },

  // Images (the raw file is public: it appears in public notes).
  "GET /api/images": { access: "browser-user" },
  // One image (MAX_IMAGE_BYTES, domain/imageStorage.ts) plus the multipart envelope.
  "POST /api/images": { access: "browser-user", maxBody: 6 * MiB },
  "DELETE /api/images/:id": { access: "browser-user" },
  "GET /api/images/:id/raw": { access: "public" },

  // Publications and sites.
  "GET /pub/:file": { access: "public" },
  "POST /api/notes/:id/publications": { access: "browser-user" },
  "GET /api/publications": { access: "browser-user" },
  "DELETE /api/publications/:id": { access: "browser-user" },
  "GET /sites/:pubId": { access: "public" },
  "PUT /api/sites/:pubId": { access: "browser-user" },
  "POST /api/sites/:pubId/suggest": { access: "browser-user" },

  // Open helpers (rate-limited in their handlers).
  "GET /api/link-preview": { access: "public" },
  "GET /__scenarios": { access: "public" },
  "GET /__scenarios/:name": { access: "public" },

  // Pages.
  "GET /": { access: "public" },
  "GET /guest": { access: "public" },
  "GET /notes": { access: "user-page" },
  "GET /trash": { access: "user-page" },
  "GET /settings": { access: "user-page" },
  "GET /sites/:pubId/edit": { access: "user-page" },
  // Public notes are viewable by anyone; the handlers decide (application/notePageAccess).
  "GET /notes/:id/edit": { access: "public" },
  "GET /notes/:id": { access: "public" },
} satisfies Record<string, RoutePolicy>;

export type RouteKey = keyof typeof ROUTE_POLICY;

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** The registered route that handles this request (`METHOD /pattern`), or null if none does. */
export function handlerRouteKey(c: Context): string | null {
  const handler = matchedRoutes(c).findLast((r) => r.method !== "ALL");
  return handler ? `${handler.method} ${handler.path}` : null;
}

/**
 * Whether an unsafe request carrying no `Authorization` came from our own
 * origin. Browsers send `Origin` on every cross-origin and same-origin POST;
 * `Sec-Fetch-Site` covers the rare one that doesn't.
 */
export function sameOriginRequest(c: Context): boolean {
  const origin = c.req.header("Origin");
  if (origin) return origin === new URL(c.req.url).origin;
  return c.req.header("Sec-Fetch-Site") === "same-origin";
}

export function routePolicyMiddleware(
  table: Record<string, RoutePolicy> = ROUTE_POLICY
): MiddlewareHandler<Env> {
  return async (c, next) => {
    const key = handlerRouteKey(c);
    // No handler: the 404 page.
    if (!key) return next();
    const policy = table[key];
    if (!policy) {
      console.error(`Route without a policy: ${key}`);
      return c.json({ error: "Forbidden" }, 403);
    }
    if (policy.access === "self") return next();

    const bearer = !!c.req.header("Authorization");
    if (UNSAFE.has(c.req.method) && !bearer && !sameOriginRequest(c)) {
      return c.json({ error: "Cross-origin request refused" }, 403);
    }
    if ((policy.access === "browser" || policy.access === "browser-user") && bearer) {
      return c.json({ error: "Use the web app for this; API tokens only reach notes" }, 403);
    }
    if (!c.get("user")) {
      if (policy.access === "user-page") return c.redirect("/");
      if (policy.access === "user" || policy.access === "browser-user") {
        return c.json({ error: "Unauthorized" }, 401);
      }
    }

    if (!UNSAFE.has(c.req.method)) return next();
    return bodyLimit({
      maxSize: policy.maxBody ?? DEFAULT_MAX_BODY,
      onError: (c) => c.json({ error: "Payload Too Large" }, 413),
    })(c, next);
  };
}
