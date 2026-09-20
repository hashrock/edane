/**
 * 開発用の認証バイパス（DEV_BYPASS_AUTH が有効なときだけ selectAuth が選ぶ）。
 *
 * resolve の優先順位:
 *   1. `?guest=1` / dev_guest Cookie → 未ログイン（ランディングページの確認用）
 *   2. 署名付き impersonate Cookie（`signIn` が書く）→ そのユーザー
 *   3. それ以外 → Dev User（DB に無ければ作る）
 *
 * `signIn` は impersonate Cookie を書き、guest トグルも解除する（「以後の
 * リクエストで resolve が user を返す」契約を guest 状態からでも満たすため）。
 */
import type { Context } from "hono";
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../global.d";
import type { SessionUser } from "../user";
import type { AuthProvider } from "./provider";
import { resolveDevGuestPreference, clearDevGuestCookieHeader } from "../utils/devAuthBypass";
import { deleteSignedUserCookie, readSignedUserCookie, writeSignedUserCookie } from "../utils/session";
import { findUserById, insertUser } from "../utils/userRepository";

export const IMPERSONATE_COOKIE = "dev_impersonate";
const IMPERSONATE_MAX_AGE = 60 * 60 * 24;

export const DEV_USER: SessionUser = {
  id: "dev-user",
  email: "dev@localhost",
  name: "Dev User",
  avatarUrl: "",
};

/** Dev User の行を保証して返す（従来の middleware と同じ）。 */
export async function ensureDevUser(c: Context<Env>): Promise<SessionUser> {
  const db = drizzle(c.env.DB);
  if (!(await findUserById(db, DEV_USER.id))) await insertUser(db, DEV_USER);
  return DEV_USER;
}

export interface BypassDeps {
  /** 既定は {@link ensureDevUser}。テストは DB を触らないスタブを渡す。 */
  devUser(c: Context<Env>): Promise<SessionUser>;
}

export function bypassAuth(deps: BypassDeps = { devUser: ensureDevUser }): AuthProvider {
  return {
    kind: "bypass",
    async resolve(c) {
      const { guest, setCookieHeader } = resolveDevGuestPreference(
        c.req.header("Cookie") || "",
        new URL(c.req.url).searchParams.get("guest")
      );
      if (setCookieHeader) c.header("Set-Cookie", setCookieHeader, { append: true });
      if (guest) return null;
      return (await readSignedUserCookie(c, IMPERSONATE_COOKIE)) ?? deps.devUser(c);
    },
    async signIn(c, user) {
      c.header("Set-Cookie", clearDevGuestCookieHeader(), { append: true });
      await writeSignedUserCookie(c, IMPERSONATE_COOKIE, user, IMPERSONATE_MAX_AGE);
    },
    async signOut(c) {
      deleteSignedUserCookie(c, IMPERSONATE_COOKIE);
    },
  };
}
