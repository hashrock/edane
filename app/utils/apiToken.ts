import type { Context } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { apiTokens, users } from "../db/schema";
import { and, eq, gt } from "drizzle-orm";
import type { SessionUser } from "../user";
import { hashToken } from "./tokenHash";

/** The token in an `Authorization: Bearer <token>` header, or undefined. */
export function bearerToken(c: Context): string | undefined {
  const authHeader = c.req.header("Authorization");
  return authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
}

/** How long an API token works after it is issued. */
export const API_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** The live (unexpired) API token row for a raw token: its id and owner. One query. */
export async function findApiToken(c: Context, token: string): Promise<{ id: string; userId: string } | null> {
  const row = await drizzle(c.env.DB)
    .select({ id: apiTokens.id, userId: apiTokens.userId })
    .from(apiTokens)
    .where(and(eq(apiTokens.tokenHash, await hashToken(token)), gt(apiTokens.expiresAt, Date.now())))
    .get();
  return row ?? null;
}

/** The id of the user an API token belongs to (one query). Null if invalid or expired. */
export async function getUserIdByApiToken(c: Context, token: string): Promise<string | null> {
  return (await findApiToken(c, token))?.userId ?? null;
}

/** The user a Bearer API token belongs to, and the token row it was. Null if invalid or expired. */
export async function getUserByToken(
  c: Context
): Promise<{ user: SessionUser; tokenId: string } | null> {
  const token = bearerToken(c);
  const found = token ? await findApiToken(c, token) : null;
  if (!found) return null;
  const userId = found.userId;

  const user = await drizzle(c.env.DB)
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (!user) return null;

  return {
    user: { id: user.id, email: user.email, name: user.name || "", avatarUrl: user.avatarUrl || "" },
    tokenId: found.id,
  };
}
