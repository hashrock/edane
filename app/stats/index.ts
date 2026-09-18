/**
 * サインアップ数の endpoint（`GET /api/stats`）。repos.hashrock.info の管理画面が
 * 各サービスから件数を集めるためのもの。仕様は docs/stats.md。
 *
 * 認証は `Authorization: Bearer <STATS_TOKEN>` だけ。セッション・Cookie・AuthProvider
 * には一切依存しないので、server.ts は認証ミドルウェアより前に mount する。
 * STATS_TOKEN が未設定なら endpoint 自体が無い扱い（404）。
 */
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../global.d";
import { countUsers, type UserCounts } from "../utils/userRepository";

export const STATS_SERVICE = "edane";

export type StatsResponse = { service: string; generated_at: string; users: UserCounts };

export type StatsAccess = "disabled" | "unauthorized" | "ok";

/** 未設定 → disabled（404）、Bearer が一致しない → unauthorized（401）。比較は定数時間。 */
export async function resolveStatsAccess(
  configuredToken: string | undefined,
  authorization: string | undefined
): Promise<StatsAccess> {
  if (!configuredToken) return "disabled";
  const presented = /^Bearer (.+)$/.exec(authorization ?? "")?.[1];
  if (presented === undefined) return "unauthorized";
  return (await constantTimeEqual(presented, configuredToken)) ? "ok" : "unauthorized";
}

/**
 * 両方を SHA-256 にしてから比べる（長さの違いも時間に出ない）。Workers には
 * `crypto.subtle.timingSafeEqual` があり、Node（テスト）には無いので XOR の畳み込みで代える。
 */
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [da, db] = await Promise.all([digest(a), digest(b)]);
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (x: Uint8Array, y: Uint8Array) => boolean };
  if (typeof subtle.timingSafeEqual === "function") return subtle.timingSafeEqual(da, db);
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i] ^ db[i];
  return diff === 0;
}

export type StatsDeps = {
  now: () => Date;
  count: (env: Env["Bindings"], now: Date) => Promise<UserCounts>;
};

const defaultDeps: StatsDeps = {
  now: () => new Date(),
  count: (env, now) => countUsers(drizzle(env.DB), now),
};

export function statsRoutes(deps: StatsDeps = defaultDeps) {
  const r = new Hono<Env>();

  r.get("/", async (c) => {
    c.header("Cache-Control", "no-store");
    switch (await resolveStatsAccess(c.env.STATS_TOKEN, c.req.header("Authorization"))) {
      case "disabled":
        return c.notFound();
      case "unauthorized":
        return c.json({ error: "Unauthorized" }, 401);
      case "ok": {
        const now = deps.now();
        const body: StatsResponse = {
          service: STATS_SERVICE,
          generated_at: now.toISOString(),
          users: await deps.count(c.env, now),
        };
        return c.json(body);
      }
    }
  });

  return r;
}
