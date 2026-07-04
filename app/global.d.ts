import type { SessionUser } from "./user";

declare module "hono" {
  interface ContextVariableMap {
    user: SessionUser | null;
  }
}

export type Env = {
  Bindings: {
    DB: D1Database;
    IMAGES: R2Bucket;
    GOOGLE_ID: string;
    GOOGLE_SECRET: string;
    SESSION_SECRET: string;
    ENCRYPTION_KEY: string;
    DEV_BYPASS_AUTH?: string;
  };
  Variables: {
    user: SessionUser | null;
  };
};
