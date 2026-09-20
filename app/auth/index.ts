/**
 * env → AuthProvider の選択。アプリ全体でここだけが「バイパスか本番か」を判断する。
 * `selectAuth` は純粋（副作用なし）なので、テストで env を変えて選択を固定できる。
 */
import type { Env } from "../global.d";
import type { AuthProvider } from "./provider";
import { sessionAuth } from "./sessionAuth";
import { bypassAuth } from "./bypassAuth";

const bypass = bypassAuth();

export function selectAuth(env: Pick<Env["Bindings"], "DEV_BYPASS_AUTH">): AuthProvider {
  return env.DEV_BYPASS_AUTH ? bypass : sessionAuth;
}

export { authMiddleware, type AuthProvider } from "./provider";
