/**
 * An in-memory D1 for node tests, on Node's built-in SQLite with every file in
 * migrations/ applied. Enough of the D1 API for drizzle-orm/d1 and the raw
 * prepare/bind/first calls in NoteRoom: the SQL itself (and the schema it runs
 * against) is what these tests check, not a hand-written fake of it.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";

const MIGRATIONS = new URL("./migrations/", import.meta.url);

const param = (v: unknown): SQLInputValue =>
  v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : (v as SQLInputValue);

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
      return this.rows().map((row) => Object.values(row));
    }
    /** For batch: run and collect rows (RETURNING or not). */
    exec() {
      const stmt = db.prepare(this.query);
      const params = this.params.map(param);
      const results = stmt.columns().length > 0 ? (stmt.all(...params) as Record<string, unknown>[]) : (stmt.run(...params), []);
      return { results, success: true, meta: {} };
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
