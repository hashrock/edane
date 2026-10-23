/**
 * Deleting the account (`DELETE /api/account`) through the real app on the
 * in-memory D1: it takes only a body repeating the account's email, removes
 * every row the user owns (and the image binaries in R2), and leaves other
 * users' data alone.
 */
import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import app from "./server";
import type { Env } from "./global.d";
import { sqliteD1 } from "../vitest.d1";
import { DEV_USER } from "./auth/bypassAuth";
import { insertNote, insertPublication } from "./utils/noteRepository";
import { insertUser } from "./utils/userRepository";

const KEY = "test-encryption-key";
const ORIGIN = "http://localhost";
const NOW = "2026-10-01T00:00:00.000Z";
const FAR = Date.parse("2100-01-01T00:00:00.000Z");

async function setup() {
  const deletedKeys: string[] = [];
  const IMAGES = { delete: async (keys: string | string[]) => void deletedKeys.push(...[keys].flat()) };
  const env = { DB: sqliteD1(), ENCRYPTION_KEY: KEY, SESSION_SECRET: "s", DEV_BYPASS_AUTH: "1", IMAGES } as unknown as Env["Bindings"];
  const db = drizzle(env.DB);
  const run = (sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).run();
  for (const user of [DEV_USER, { id: "other", email: "o@example.com", name: "O", avatarUrl: "" }]) {
    await insertUser(db, user);
    const { id } = user;
    const note = `${id}-note`;
    await insertNote(db, { id: note, userId: id, title: "T", plainContent: "a", isPublic: true, now: NOW }, { current: KEY });
    await insertPublication(db, { id: `${id}-pub`, userId: id, noteId: note, nodeId: "n", createdAt: NOW });
    await run("INSERT INTO web_pages (id, user_id, note_id, created_at) VALUES (?, ?, ?, ?)", `${id}-web`, id, note, NOW);
    await run("INSERT INTO note_commits (note_id, operation_id, digest, version) VALUES (?, 'op', 'd', 1)", note);
    await run("INSERT INTO note_backups (id, note_id, user_id, title, content, version, created_at) VALUES (?, ?, ?, 'T', 'x', 0, ?)", `${id}-backup`, note, id, NOW);
    await run("INSERT INTO images (id, user_id, r2_key, filename, content_type, size, created_at) VALUES (?, ?, ?, 'f.png', 'image/png', 1, ?)", `${id}-img`, id, `${id}/img`, NOW);
    await run("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", `${id}-sess`, id, NOW, FAR);
    await run("INSERT INTO api_tokens (id, user_id, name, token_hash, created_at, expires_at) VALUES (?, ?, 'default', ?, ?, ?)", `${id}-tok`, id, `${id}-hash`, NOW, FAR);
    await run("INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, 'C', '[]', ?)", `${id}-client`, NOW);
    await run("INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, expires_at) VALUES (?, ?, ?, 'r', 'c', 's', ?)", `${id}-code`, `${id}-client`, id, FAR);
    await run(
      "INSERT INTO oauth_grants (id, client_id, user_id, scope, access_token_hash, access_expires_at, refresh_token_hash, refresh_expires_at, created_at) VALUES (?, ?, ?, 's', ?, ?, ?, ?, ?)",
      `${id}-grant`, `${id}-client`, id, `${id}-at`, FAR, `${id}-rt`, FAR, NOW
    );
  }
  // Every table with a user_id column, read from the migrated schema: a new one
  // has to be seeded above (so the "other" user's row is counted) and cleared
  // by deleteUserAccount, or the first test fails.
  const { results } = await env.DB.prepare(
    "SELECT m.name FROM sqlite_master m, pragma_table_info(m.name) c WHERE m.type = 'table' AND c.name = 'user_id'"
  ).all<{ name: string }>();
  const userTables = ["users", ...results.map((r) => r.name)];
  const count = async (table: string, userId: string) =>
    (await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${table === "users" ? "id" : "user_id"} = ?`).bind(userId).first<{ n: number }>())!.n;
  const commits = async (userId: string) =>
    (await env.DB.prepare("SELECT count(*) AS n FROM note_commits WHERE note_id = ?").bind(`${userId}-note`).first<{ n: number }>())!.n;
  const del = (body: unknown, headers: Record<string, string> = { Origin: ORIGIN }) =>
    app.request("/api/account", { method: "DELETE", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);
  return { del, count, commits, deletedKeys, userTables };
}

describe("DELETE /api/account", () => {
  it("deletes everything the user owns, and nothing of anyone else's", async () => {
    const { del, count, commits, deletedKeys, userTables } = await setup();
    expect(userTables).toContain("notes");
    const res = await del({ email: DEV_USER.email });
    expect(res.status).toBe(200);
    for (const table of userTables) {
      expect(await count(table, DEV_USER.id), table).toBe(0);
      expect(await count(table, "other"), table).toBe(1);
    }
    expect(await commits(DEV_USER.id)).toBe(0);
    expect(await commits("other")).toBe(1);
    expect(deletedKeys).toEqual([`${DEV_USER.id}/img`]);
  });

  it("refuses without the account's email, deleting nothing", async () => {
    const { del, count, deletedKeys } = await setup();
    for (const body of [{}, { email: "o@example.com" }, { email: DEV_USER.email.toUpperCase() }]) {
      expect((await del(body)).status).toBe(400);
    }
    expect(await count("users", DEV_USER.id)).toBe(1);
    expect(await count("notes", DEV_USER.id)).toBe(1);
    expect(deletedKeys).toEqual([]);
  });

  it("refuses cross-origin requests and API tokens", async () => {
    const { del, count } = await setup();
    expect((await del({ email: DEV_USER.email }, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await del({ email: DEV_USER.email }, { Origin: ORIGIN, Authorization: "Bearer edane_x" })).status).toBe(403);
    expect(await count("users", DEV_USER.id)).toBe(1);
  });
});
