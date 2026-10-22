/**
 * NoteRoom re-checks a socket's credential on every load (one SQL, no extra
 * query): deleting the session or token row, or letting it expire, ends what
 * that socket can do. Runs NoteRoom's real SQL against the migrated schema.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../global.d";
import { seededD1, testRoom } from "../../vitest.d1";
import { insertNote } from "../utils/noteRepository";
import type { NoteRoom } from "./room";

const KEY = "test-encryption-key";
const alice = { id: "alice", email: "a@example.com", name: "A", avatarUrl: "" };

describe("NoteRoom credential check", () => {
  let env: Env["Bindings"];
  let room: NoteRoom;
  beforeEach(async () => {
    env = { DB: await seededD1(alice), ENCRYPTION_KEY: KEY } as Env["Bindings"];
    const db = drizzle(env.DB);
    await insertNote(db, { id: "n1", userId: "alice", title: "T", plainContent: "a", isPublic: false, now: "2026-01-01" }, { current: KEY });
    await env.DB.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ('s1', 'alice', 'x', ?)")
      .bind(Date.now() + 60_000)
      .run();
    room = testRoom(env);
  });
  const identity = { noteId: "n1", userId: "alice", credential: { table: "sessions" as const, id: "s1" } };

  it("serves the note while the session row is live", async () => {
    expect((await room.snapshot(identity)).ok).toBe(true);
  });

  it("refuses once the session row is deleted (signed out)", async () => {
    await env.DB.prepare("DELETE FROM sessions WHERE id = 's1'").run();
    expect(await room.snapshot(identity)).toMatchObject({ ok: false, code: "not-found" });
  });

  it("refuses once the session row has expired", async () => {
    await env.DB.prepare("UPDATE sessions SET expires_at = 0").run();
    expect(await room.snapshot(identity)).toMatchObject({ ok: false, code: "not-found" });
  });

  it("refuses a credential of another table name's row that doesn't exist", async () => {
    expect(await room.snapshot({ ...identity, credential: { table: "api_tokens", id: "s1" } })).toMatchObject({
      ok: false,
      code: "not-found",
    });
  });

  it("without a credential (HTTP / MCP, re-authenticated per request) only owner and trash matter", async () => {
    await env.DB.prepare("DELETE FROM sessions").run();
    expect((await room.snapshot({ noteId: "n1", userId: "alice" })).ok).toBe(true);
  });
});
