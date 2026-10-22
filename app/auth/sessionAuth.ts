/**
 * 本番の認証：セッション Cookie（サーバー側の sessions 行を指す）、次に Bearer の API トークン。
 * どちらも使った行を `credential` に置く（失効したら WebSocket も書けなくなる。docs/adr/0006）。
 * impersonate Cookie（bypassAuth.ts）は名前が違うので、ここでは一切読まれない。
 */
import type { AuthProvider } from "./provider";
import { getSession, setSession, clearSession } from "../utils/session";
import { getUserByToken } from "../utils/apiToken";

export const sessionAuth: AuthProvider = {
  kind: "session",
  async resolve(c) {
    const session = await getSession(c);
    if (session) return { user: session.user, credential: { table: "sessions", id: session.sid } };
    const token = await getUserByToken(c);
    if (token) return { user: token.user, credential: { table: "api_tokens", id: token.tokenId } };
    return null;
  },
  async signIn(c, user) {
    await setSession(c, user);
  },
  async signOut(c) {
    await clearSession(c);
  },
};
