import type { SessionUser } from "./user";
import type { AuthProvider } from "./auth/provider";

declare module "hono" {
  interface ContextVariableMap {
    user: SessionUser | null;
    auth: AuthProvider;
  }
}

export type Env = {
  Bindings: {
    DB: D1Database;
    IMAGES: R2Bucket;
    AI: Ai;
    GOOGLE_ID: string;
    GOOGLE_SECRET: string;
    SESSION_SECRET: string;
    ENCRYPTION_KEY: string;
    DEV_BYPASS_AUTH?: string;
    /** GET /api/stats の Bearer トークン（secret）。未設定なら endpoint は 404。 */
    STATS_TOKEN?: string;
  };
  Variables: {
    user: SessionUser | null;
    /** このリクエストの認証プロバイダ（auth/index.ts の selectAuth が env から選ぶ）。 */
    auth: AuthProvider;
  };
};
