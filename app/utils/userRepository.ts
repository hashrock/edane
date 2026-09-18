import type { DrizzleD1Database } from "drizzle-orm/d1";
import { and, eq, notLike, sql } from "drizzle-orm";
import { users } from "../db/schema";
import type { SessionUser } from "../user";

type UserRow = typeof users.$inferSelect;

export async function findUserById(db: DrizzleD1Database, id: string): Promise<UserRow | null> {
  return (await db.select().from(users).where(eq(users.id, id)).get()) ?? null;
}

export async function findUserByEmail(db: DrizzleD1Database, email: string): Promise<UserRow | null> {
  return (await db.select().from(users).where(eq(users.email, email)).get()) ?? null;
}

/**
 * The one INSERT into `users`, shared by the Google callback, the dev bypass
 * (Dev User) and the scenario route (throwaway users), so a new column has a
 * single place to land.
 */
export async function insertUser(
  db: DrizzleD1Database,
  user: SessionUser,
  createdAt: string = new Date().toISOString()
): Promise<void> {
  await db.insert(users).values({
    id: user.id,
    email: user.email,
    name: user.name || null,
    avatarUrl: user.avatarUrl || null,
    createdAt,
  });
}

/** GET /api/stats が返す件数（キー名はレスポンスの JSON にそのまま載る）。 */
export type UserCounts = { total: number; new_7d: number; new_30d: number };

/**
 * サインアップ数。UI テスト用の使い捨てユーザーは数えない：id が `scenario-` で始まるもの
 * （サービス横断の取り決め）と、scenarios/response.ts の throwawayUser が作る
 * `@scenario.invalid` のメール（このアプリの使い捨てユーザーは id が UUID なので）。
 * new_7d / new_30d は `now` のちょうど 7 / 30 日前以降（境界を含む）。
 * created_at は toISOString 形式なので julianday で時刻として比べる
 * （`datetime()` の "YYYY-MM-DD HH:MM:SS" と文字列比較すると T と空白で食い違う）。
 */
export async function countUsers(db: DrizzleD1Database, now: Date): Promise<UserCounts> {
  const at = now.toISOString();
  const createdSince = (days: number) =>
    sql<number>`count(*) filter (where julianday(${users.createdAt}) >= julianday(${at}, ${`-${days} days`}))`;
  const row = await db
    .select({ total: sql<number>`count(*)`, new_7d: createdSince(7), new_30d: createdSince(30) })
    .from(users)
    .where(and(notLike(users.id, "scenario-%"), notLike(users.email, "%@scenario.invalid")))
    .get();
  return row ?? { total: 0, new_7d: 0, new_30d: 0 };
}
