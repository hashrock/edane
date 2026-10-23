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
 * - `anonymous`: anyone, and the handler never reads the user, so the session
 *   isn't looked up at all (no D1 read): raw images, published data.
 * - `public`: anyone, guests included.
 * - `user`: signed in, by browser session or API token (Bearer). API tokens
 *   are scoped to notes (ADR 0005), so only note routes use this.
 * - `user-page`: a signed-in page; a guest is sent to the landing page.
 * - `browser`: no `Authorization` header (the handler decides about guests).
 * - `browser-user`: signed in by the browser session, never by an API token.
 *   Credential management and the other web-app-only APIs: a leaked token
 *   must not mint more tokens or reach beyond notes.
 * - `self`: authenticates itself before the session middleware (Bearer /
 *   OAuth / stats token) and never takes a cookie; only the table lookup applies.
 *
 * Two middlewares, because some rules need the signed-in user and some must
 * run before anything reads the request:
 * - {@link routePolicyMiddleware} (first): finds the policy (refusing routes
 *   without one), and for every non-`self` route applies CSRF (an unsafe
 *   method or a WebSocket upgrade without `Authorization` must come from our
 *   own origin; SameSite=Lax alone lets sibling subdomains through), the
 *   browser-only rule, the route's rate limit and its body size.
 * - {@link requireRouteUser} (after the session middleware): guests on
 *   signed-in routes get 401, or the landing page for `user-page`.
 * Handlers then take the user from {@link signedInUser}.
 */
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { matchedRoutes } from "hono/route";
import type { Env } from "../global.d";
import type { SessionUser } from "../user";

export type Access = "anonymous" | "public" | "user" | "user-page" | "browser" | "browser-user" | "self";

/** IP-keyed rate limit bindings (wrangler.jsonc `ratelimits`). */
type RateLimitBinding = "LINK_PREVIEW_LIMITER";

export interface RoutePolicy {
  access: Access;
  /** Request body limit in bytes (default 1 MiB). */
  maxBody?: number;
  /** Per-IP rate limit; over it, 429. */
  rateLimit?: RateLimitBinding;
}

const MiB = 1024 * 1024;
const DEFAULT_MAX_BODY = MiB;

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
  "DELETE /api/account": { access: "browser-user" },

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
  "GET /api/images/:id/raw": { access: "anonymous" },

  // Publications and web pages.
  "GET /pub/:file": { access: "anonymous" },
  "POST /api/notes/:id/publications": { access: "browser-user" },
  "GET /api/publications": { access: "browser-user" },
  "DELETE /api/publications/:id": { access: "browser-user" },
  "GET /w/:id": { access: "anonymous" },
  "GET /api/notes/:id/webpage": { access: "browser-user" },
  "POST /api/notes/:id/webpage": { access: "browser-user" },
  "DELETE /api/notes/:id/webpage": { access: "browser-user" },

  // Open helpers. Link previews fetch third-party pages: 60 per minute per IP.
  "GET /api/link-preview": { access: "anonymous", rateLimit: "LINK_PREVIEW_LIMITER" },
  "GET /__scenarios": { access: "public" },
  "GET /__scenarios/:name": { access: "public" },

  // Pages.
  "GET /": { access: "public" },
  "GET /guest": { access: "public" },
  "GET /notes": { access: "user-page" },
  "GET /trash": { access: "user-page" },
  "GET /settings": { access: "user-page" },
  // Public notes are viewable by anyone; the handlers decide (application/notePageAccess).
  "GET /notes/:id/edit": { access: "public" },
  "GET /notes/:id": { access: "public" },
} satisfies Record<string, RoutePolicy>;

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** The registered route that handles this request (`METHOD /pattern`), or null if none does. */
function handlerRouteKey(c: Context): string | null {
  const handler = matchedRoutes(c).findLast((r) => r.method !== "ALL");
  return handler ? `${handler.method} ${handler.path}` : null;
}

/**
 * Whether a request carrying no `Authorization` came from our own origin.
 * Browsers send `Origin` on every POST and WebSocket upgrade; `Sec-Fetch-Site`
 * covers the rare request that doesn't.
 */
function sameOriginRequest(c: Context): boolean {
  const origin = c.req.header("Origin");
  if (origin) return origin === new URL(c.req.url).origin;
  return c.req.header("Sec-Fetch-Site") === "same-origin";
}

/** Phase one: runs first, before any route (see the module comment). */
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
    c.set("routePolicy", policy);
    if (policy.access === "self") return next();

    const bearer = !!c.req.header("Authorization");
    const upgrade = c.req.header("Upgrade")?.toLowerCase() === "websocket";
    if ((UNSAFE.has(c.req.method) || upgrade) && !bearer && !sameOriginRequest(c)) {
      return c.json({ error: "Cross-origin request refused" }, 403);
    }
    if ((policy.access === "browser" || policy.access === "browser-user") && bearer) {
      return c.json({ error: "Use the web app for this; API tokens only reach notes" }, 403);
    }
    if (policy.rateLimit) {
      const key = c.req.header("CF-Connecting-IP") ?? "unknown";
      if (!(await c.env[policy.rateLimit].limit({ key })).success) {
        c.header("Retry-After", "60");
        return c.json({ error: "Too many requests" }, 429);
      }
    }

    if (!UNSAFE.has(c.req.method)) return next();
    return bodyLimit({
      maxSize: policy.maxBody ?? DEFAULT_MAX_BODY,
      onError: (c) => c.json({ error: "Payload Too Large" }, 413),
    })(c, next);
  };
}

/** Phase two: after the session middleware, turn guests away from signed-in routes. */
export const requireRouteUser: MiddlewareHandler<Env> = async (c, next) => {
  const access = c.get("routePolicy")?.access;
  if (!c.get("user")) {
    if (access === "user-page") return c.redirect("/");
    if (access === "user" || access === "browser-user") return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
};

/**
 * The signed-in user, in a handler whose route requires one (`user`,
 * `user-page`, `browser-user`): {@link requireRouteUser} already turned
 * guests away, so a missing user means the table is wrong (a 500, not a guest
 * path to handle).
 */
export function signedInUser(c: Context<Env>): SessionUser {
  const user = c.get("user");
  if (!user) throw new Error(`Route ${handlerRouteKey(c)} has no user; check ROUTE_POLICY`);
  return user;
}
