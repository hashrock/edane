/**
 * An in-memory D1 for node tests, on Node's built-in SQLite with every file in
 * migrations/ applied. Enough of the D1 API for drizzle-orm/d1 and the raw
 * prepare/bind/first calls in NoteRoom: the SQL itself (and the schema it runs
 * against) is what these tests check, not a hand-written fake of it.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { NoteRoom } from "./app/sync/room";

const MIGRATIONS = new URL("./migrations/", import.meta.url);

const param = (v: unknown): SQLInputValue =>
  v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : (v as SQLInputValue);

/** A NoteRoom on `env` with no open sockets (its storage is D1, so nothing else is needed). */
export function testRoom(env: { DB: D1Database; ENCRYPTION_KEY: string }): NoteRoom {
  return new NoteRoom({ getWebSockets: () => [] } as unknown as DurableObjectState, env as never);
}

/** {@link sqliteD1} with one user row already in it (most tables reference users). */
export async function seededD1(
  user = { id: "u", email: "u@example.com", name: "U", avatarUrl: "" }
): Promise<D1Database> {
  const db = sqliteD1();
  await db
    .prepare("INSERT INTO users (id, email, name, avatar_url, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(user.id, user.email, user.name, user.avatarUrl, new Date().toISOString())
    .run();
  return db;
}

export function sqliteD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(file, MIGRATIONS), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  db.exec("PRAGMA foreign_keys = ON");

  class Statement {
    constructor(
      private readonly query: string,
      private readonly params: unknown[] = []
    ) {}
    bind(...params: unknown[]) {
      return new Statement(this.query, params);
    }
    private rows(): Record<string, unknown>[] {
      return db.prepare(this.query).all(...this.params.map(param)) as Record<string, unknown>[];
    }
    async all() {
      return { results: this.rows(), success: true, meta: {} };
    }
    async first(column?: string) {
      const row = this.rows()[0];
      if (!row) return null;
      return column ? row[column] : row;
    }
    async run() {
      const info = db.prepare(this.query).run(...this.params.map(param));
      return { results: [], success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
    }
    async raw() {
      // Arrays straight from SQLite: same-named columns would collapse in an object.
      const stmt = db.prepare(this.query);
      stmt.setReturnArrays(true);
      return stmt.all(...this.params.map(param));
    }
    /** For batch: run and collect rows (RETURNING or not). */
    exec() {
      const stmt = db.prepare(this.query);
      const params = this.params.map(param);
      if (stmt.columns().length > 0) {
        const results = stmt.all(...params) as Record<string, unknown>[];
        return { results, success: true, meta: { changes: results.length } };
      }
      const info = stmt.run(...params);
      return { results: [], success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
    }
  }

  return {
    prepare: (query: string) => new Statement(query),
    async batch(statements: Statement[]) {
      db.exec("BEGIN");
      try {
        const results = statements.map((s) => s.exec());
        db.exec("COMMIT");
        return results;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    async exec(query: string) {
      db.exec(query);
      return { count: 1, duration: 0 };
    },
  } as unknown as D1Database;
}
