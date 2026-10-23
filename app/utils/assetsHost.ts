/**
 * Uploaded images are served from their own origin (`ASSETS_ORIGIN`, e.g.
 * https://edane-assets.hashrock.info), so a file opened directly can never
 * run script on the app's origin. This sits on top of the sandbox / nosniff
 * headers of imageResponseHeaders (domain/imageStorage.ts), not instead of them.
 *
 * Same Worker, split by Host:
 * - On the assets host only `GET /api/images/:id/raw` exists; every other
 *   route is a 404 there (no app pages, no session APIs).
 * - On the app host that route redirects to the assets host: notes saved
 *   before the move hold the relative URL, and <img> follows redirects.
 *
 * Dev builds ignore `ASSETS_ORIGIN` and keep serving images same-origin.
 */
import type { MiddlewareHandler } from "hono";
import type { Env } from "../global.d";

/** The one route the assets host serves. */
export const IMAGE_RAW_PATH = /^\/api\/images\/[^/]+\/raw$/;

export const imageRawPath = (id: string) => `/api/images/${id}/raw`;

/** The configured assets origin, or null to serve images from the app's own origin. */
export function resolveAssetsOrigin(value: string | undefined, dev: boolean): string | null {
  if (dev || !value) return null;
  return new URL(value).origin;
}

export const assetsOrigin = (env: Pick<Env["Bindings"], "ASSETS_ORIGIN">) =>
  resolveAssetsOrigin(env.ASSETS_ORIGIN, import.meta.env.DEV);

/** The URL to hand out for an image: absolute on the assets host, else the relative raw path. */
export const imageUrl = (id: string, origin: string | null) => `${origin ?? ""}${imageRawPath(id)}`;

/** Whether this request arrived on the assets host. */
export const onAssetsHost = (requestUrl: string, origin: string | null) =>
  origin !== null && new URL(requestUrl).host === new URL(origin).host;

/** First middleware: on the assets host, everything but the image route is a 404. */
export function assetsHostGate(
  origin: (env: Env["Bindings"]) => string | null = assetsOrigin
): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (!onAssetsHost(c.req.url, origin(c.env))) return next();
    if ((c.req.method === "GET" || c.req.method === "HEAD") && IMAGE_RAW_PATH.test(c.req.path)) return next();
    return c.text("Not Found", 404);
  };
}
