/**
 * env → AuthProvider の選択。アプリ全体でここだけが「バイパスか本番か」を判断する。
 * `selectAuth` は純粋（副作用なし）なので、テストで env を変えて選択を固定できる。
 */
import type { Env } from "../global.d";
import type { AuthProvider } from "./provider";
import { sessionAuth } from "./sessionAuth";
import { bypassAuth } from "./bypassAuth";

/**
 * The bypass needs both: a dev build (`import.meta.env.DEV`, false in every
 * `vite build`, so a production bundle can't select it — and drops its code)
 * and an explicit `DEV_BYPASS_AUTH=1` / `true` in `.dev.vars` (not any
 * non-empty string: `"false"` used to switch it on).
 */
export function selectAuth(env: Pick<Env["Bindings"], "DEV_BYPASS_AUTH">): AuthProvider {
  return import.meta.env.DEV && BYPASS_ON.has(env.DEV_BYPASS_AUTH ?? "") ? bypassAuth() : sessionAuth;
}

const BYPASS_ON = new Set(["1", "true"]);

export { authMiddleware, type AuthProvider } from "./provider";
