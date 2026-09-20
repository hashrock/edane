/**
 * 認証プロバイダ：「誰としてログインしているか」を決める唯一の口。
 *
 * - `sessionAuth`（本番）: 署名付きセッション Cookie + Bearer トークン。挙動は従来どおり。
 * - `bypassAuth`（DEV_BYPASS_AUTH 有効時のみ）: 署名付き impersonate Cookie があれば
 *   そのユーザー、無ければ Dev User。`?guest=1` トグルもここに閉じる。
 *
 * 選択は `selectAuth(env)`（auth/index.ts）の 1 箇所。ミドルウェアは
 * `c.set("user", await auth.resolve(c))` するだけで、シナリオ固有の分岐を持たない。
 * Google OAuth の callback・ログアウト・シナリオ route はすべて `signIn` / `signOut` を
 * 通り、ログイン手順はプロバイダの中にしか無い。
 */
import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../global.d";
import type { SessionUser } from "../user";

export interface AuthProvider {
  /**
   * `"bypass"` は開発用。使い捨てユーザーで `signIn` してよいのはこのときだけ
   * （本番で任意のユーザーとしてログインできてはいけない）。
   */
  readonly kind: "session" | "bypass";
  /** 毎リクエスト、ミドルウェアが呼ぶ。null = 未ログイン。 */
  resolve(c: Context<Env>): Promise<SessionUser | null>;
  /** 以後のリクエストで `resolve` が `user` を返すようにする（ブラウザは複数リクエストをまたぐ）。 */
  signIn(c: Context<Env>, user: SessionUser): Promise<void>;
  signOut(c: Context<Env>): Promise<void>;
}

/**
 * `select` は env からプロバイダを選ぶ（Workers では env がリクエスト毎にしか
 * 手に入らないので、構築時ではなくここで選ぶ）。テストは固定ユーザーを返す
 * モックを渡せば DB なしでハンドラを叩ける。
 */
export function authMiddleware(select: (env: Env["Bindings"]) => AuthProvider): MiddlewareHandler<Env> {
  return async (c, next) => {
    const auth = select(c.env);
    c.set("auth", auth);
    c.set("user", await auth.resolve(c));
    await next();
  };
}
