import type { Context } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { apiTokens, users } from "../db/schema";
import { eq } from "drizzle-orm";
import type { SessionUser } from "../user";
import { hashToken } from "./tokenHash";

/** The id of the user a Bearer token belongs to (one query). Null if invalid. */
export async function getUserIdByToken(c: Context): Promise<string | null> {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const hash = await hashToken(authHeader.slice(7));
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
