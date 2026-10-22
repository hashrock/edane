import type { Context } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { apiTokens, users } from "../db/schema";
import { eq } from "drizzle-orm";
import type { SessionUser } from "../user";
import { hashToken } from "./tokenHash";

/** The token in an `Authorization: Bearer <token>` header, or undefined. */
export function bearerToken(c: Context): string | undefined {
  const authHeader = c.req.header("Authorization");
  return authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
}

/** The id of the user a Bearer token belongs to (one query). Null if invalid. */
export async function getUserIdByToken(c: Context): Promise<string | null> {
  const token = bearerToken(c);
  return token ? getUserIdByApiToken(c, token) : null;
}

/** The id of the user an API token belongs to (one query). Null if invalid. */
export async function getUserIdByApiToken(c: Context, token: string): Promise<string | null> {
  const hash = await hashToken(token);
  const row = await drizzle(c.env.DB)
    .select({ userId: apiTokens.userId })
    .from(apiTokens)
    .where(eq(apiTokens.tokenHash, hash))
    .get();
  return row?.userId ?? null;
}

/** Look up a user by Bearer token. Returns null if invalid. */
export async function getUserByToken(
  c: Context
): Promise<SessionUser | null> {
  const userId = await getUserIdByToken(c);
  if (!userId) return null;

  const user = await drizzle(c.env.DB)
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    name: user.name || "",
    avatarUrl: user.avatarUrl || "",
  };
}
