/**
 * 本番の認証：セッション Cookie、次に Bearer トークン（デスクトップアプリ）。
 * 従来の middleware / setSession / clearSession をそのまま移しただけで、挙動は変えない。
 * impersonate Cookie（bypassAuth.ts）は名前が違うので、ここでは一切読まれない。
 */
import type { AuthProvider } from "./provider";
import { getSession, setSession, clearSession } from "../utils/session";
import { getUserByToken } from "../utils/apiToken";

export const sessionAuth: AuthProvider = {
  kind: "session",
  async resolve(c) {
    return (await getSession(c)) || (await getUserByToken(c));
  },
  async signIn(c, user) {
    await setSession(c, user);
  },
  async signOut(c) {
    clearSession(c);
  },
};
