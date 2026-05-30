import type { Context } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { apiTokens, users } from "../db/schema";
import { eq } from "drizzle-orm";
import type { SessionUser } from "./session";

/** SHA-256 hash of a token string, returned as hex. */
export async function hashToken(token: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Look up a user by Bearer token. Returns null if invalid. */
export async function getUserByToken(
  c: Context
): Promise<SessionUser | null> {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.slice(7);
  const hash = await hashToken(token);

  const db = drizzle(c.env.DB);
  const row = await db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.tokenHash, hash))
    .get();
  if (!row) return null;

  const user = await db
    .select()
    .from(users)
    .where(eq(users.id, row.userId))
    .get();
  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    name: user.name || "",
    avatarUrl: user.avatarUrl || "",
  };
}
