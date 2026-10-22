import type { Context } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, gt } from "drizzle-orm";
import { oauthGrants } from "../db/schema";
import { hashToken } from "./tokenHash";
import { bearerToken, getUserIdByApiToken } from "./apiToken";

/** OAuth のアクセストークンの接頭辞。`/mcp` はこれで API トークンと見分けて 1 回の検索で済ませる。 */
export const ACCESS_TOKEN_PREFIX = "edane_oat_";

export const resourceMetadataUrl = (origin: string) => `${origin}/.well-known/oauth-protected-resource/mcp`;

/** `/mcp` の 401 に付ける WWW-Authenticate（MCP の認可仕様: resource_metadata で発見させる）。 */
export function mcpChallenge(origin: string, invalidToken: boolean): string {
  const error = invalidToken ? ', error="invalid_token"' : "";
  return `Bearer realm="edane", resource_metadata="${resourceMetadataUrl(origin)}"${error}`;
}

/**
 * `/mcp` の Bearer の持ち主。API トークンか OAuth のアクセストークン（app/oauth/ が発行）かを
 * 接頭辞で分け、どちらも 1 回の検索で済ませる。null = 無効・期限切れ。
 */
export async function getUserIdByBearer(c: Context): Promise<string | null> {
  const token = bearerToken(c);
  if (!token) return null;
  if (!token.startsWith(ACCESS_TOKEN_PREFIX)) return getUserIdByApiToken(c, token);
  const row = await drizzle(c.env.DB)
    .select({ userId: oauthGrants.userId })
    .from(oauthGrants)
    .where(and(eq(oauthGrants.accessTokenHash, await hashToken(token)), gt(oauthGrants.accessExpiresAt, Date.now())))
    .get();
  return row?.userId ?? null;
}
