import type { Context } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, gt } from "drizzle-orm";
import { oauthGrants } from "../db/schema";
import { hashToken } from "./tokenHash";

/**
 * The user an OAuth access token (issued by app/oauth/ for the remote MCP
 * endpoint) belongs to, or null if unknown or expired. One query.
 */
export async function getUserIdByOAuthAccessToken(c: Context, token: string): Promise<string | null> {
  const row = await drizzle(c.env.DB)
    .select({ userId: oauthGrants.userId })
    .from(oauthGrants)
    .where(and(eq(oauthGrants.accessTokenHash, await hashToken(token)), gt(oauthGrants.accessExpiresAt, Date.now())))
    .get();
  return row?.userId ?? null;
}
