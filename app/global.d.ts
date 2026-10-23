import type { Credential, SessionUser } from "./user";
import type { AuthProvider } from "./auth/provider";
import type { RoutePolicy } from "./auth/routePolicy";

declare module "hono" {
  interface ContextVariableMap {
    user: SessionUser | null;
    auth: AuthProvider;
    credential: Credential | null;
    routePolicy: RoutePolicy;
  }
}

export type Env = {
  Bindings: {
    DB: D1Database;
    NOTE_ROOMS: DurableObjectNamespace<import("./sync/room").NoteRoom>;
    IMAGES: R2Bucket;
    GOOGLE_ID: string;
    GOOGLE_SECRET: string;
    SESSION_SECRET: string;
    ENCRYPTION_KEY: string;
    /** The key before the last rotation, still accepted for reading (utils/crypto.ts). */
    ENCRYPTION_KEY_PREVIOUS?: string;
    DEV_BYPASS_AUTH?: string;
    /** POST /oauth/register の IP ごとのレート制限（wrangler.jsonc の ratelimits）。 */
    OAUTH_REGISTER_LIMITER: RateLimit;
    /** GET /api/link-preview の IP ごとのレート制限（wrangler.jsonc の ratelimits）。 */
    LINK_PREVIEW_LIMITER: RateLimit;
    /** GET /api/stats の Bearer トークン（secret）。未設定なら endpoint は 404。 */
    STATS_TOKEN?: string;
    /** 画像を配信する別オリジン（utils/assetsHost.ts）。未設定・dev ビルドなら本体オリジンから配信。 */
    ASSETS_ORIGIN?: string;
  };
  Variables: {
    user: SessionUser | null;
    /** このリクエストの認証プロバイダ（auth/index.ts の selectAuth が env から選ぶ）。 */
    auth: AuthProvider;
    /** 認証に使った行（セッションか API トークン）。dev のバイパスでは null。 */
    credential: Credential | null;
    /** このリクエストのルートの方針（auth/routePolicy.ts）。ハンドラーの無い 404 では未設定。 */
    routePolicy: RoutePolicy;
  };
};
