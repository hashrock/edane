import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/d1";
import { countUsers, insertUser } from "./userRepository";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

/**
 * 本物の SQLite（node:sqlite）に実際のマイグレーションを当て、drizzle-orm/d1 が
 * 使う分だけの D1Database（prepare → bind → raw / all / run）をかぶせる。
 * count(*) FILTER や julianday の解釈を SQLite 自身に確かめさせるため。
 */
function sqliteD1(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS, file), "utf-8"));
  }
  const prepare = (query: string) => {
    let params: unknown[] = [];
    const stmt = {
      bind(...values: unknown[]) {
        params = values;
        return stmt;
      },
      async raw() {
        const s = sqlite.prepare(query);
        s.setReturnArrays(true);
        return s.all(...(params as never[]));
      },
      async all() {
        return { results: sqlite.prepare(query).all(...(params as never[])) };
      },
      async run() {
        sqlite.prepare(query).run(...(params as never[]));
        return { success: true, results: [] };
      },
    };
    return stmt;
  };
  return { prepare } as unknown as D1Database;
}

const NOW = new Date("2026-09-18T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

async function seed(rows: { id: string; email?: string; createdAt: string }[]) {
  const db = drizzle(sqliteD1());
  for (const r of rows) {
    await insertUser(db, { id: r.id, email: r.email ?? `${r.id}@example.com`, name: r.id, avatarUrl: "" }, r.createdAt);
  }
  return db;
}

describe("countUsers", () => {
  it("returns zeros for an empty table", async () => {
    expect(await countUsers(await seed([]), NOW)).toEqual({ total: 0, new_7d: 0, new_30d: 0 });
  });

  it("includes a user created exactly 7 / 30 days ago and excludes one a millisecond earlier", async () => {
    const db = await seed([
      { id: "at-7d", createdAt: ago(7 * DAY) },
      { id: "before-7d", createdAt: ago(7 * DAY + 1) },
      { id: "at-30d", createdAt: ago(30 * DAY) },
      { id: "before-30d", createdAt: ago(30 * DAY + 1) },
    ]);
    expect(await countUsers(db, NOW)).toEqual({ total: 4, new_7d: 1, new_30d: 3 });
  });

  it("counts from the injected now, not the wall clock", async () => {
    const db = await seed([{ id: "old", createdAt: "2020-01-01T00:00:00.000Z" }]);
    expect(await countUsers(db, new Date("2020-01-02T00:00:00.000Z"))).toEqual({ total: 1, new_7d: 1, new_30d: 1 });
  });

  it("excludes UI-test scenario users (scenario- id or @scenario.invalid email)", async () => {
    const db = await seed([
      { id: "real", createdAt: ago(DAY) },
      { id: "scenario-editor-abc123", createdAt: ago(DAY) },
      { id: "3f2c9a4e-uuid", email: "3f2c9a4e-uuid@scenario.invalid", createdAt: ago(DAY) },
    ]);
    expect(await countUsers(db, NOW)).toEqual({ total: 1, new_7d: 1, new_30d: 1 });
  });
});
