import type { SessionUser } from "./utils/session";

declare module "hono" {
  interface ContextVariableMap {
    user: SessionUser | null;
  }
}

export type Env = {
  Bindings: {
    DB: D1Database;
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
