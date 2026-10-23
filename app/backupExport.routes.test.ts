/**
 * Backups (`/api/notes/:id/backups*`, `/notes/:id/history`) and the data export
 * (`/api/export`) through the real app on the in-memory D1, with NoteRoom run
 * in-process: only the owner sees and restores a note's backups, and the export
 * holds every note of the user — private ones decrypted — and nobody else's.
 */
import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import app from "./server";
import type { Env } from "./global.d";
import { sqliteD1, testRoom } from "../vitest.d1";
import { DEV_USER } from "./auth/bypassAuth";
import { insertNote } from "./utils/noteRepository";
import { insertUser } from "./utils/userRepository";
import { documentToText } from "./application/persistence";
import type { NoteRoom } from "./sync/room";
import { noteRoom } from "./utils/noteRoom";
import { readZip } from "./lib/zip.testHelpers";

const KEY = "test-encryption-key";
const ORIGIN = "http://localhost";

async function setup() {
  const env = { DB: sqliteD1(), ENCRYPTION_KEY: KEY, SESSION_SECRET: "s", DEV_BYPASS_AUTH: "1" } as Env["Bindings"];
  const rooms = new Map<string, NoteRoom>();
  env.NOTE_ROOMS = {
    idFromName: (name: string) => name,
    get: (name: string) => rooms.get(name) ?? rooms.set(name, testRoom(env)).get(name)!,
  } as unknown as Env["Bindings"]["NOTE_ROOMS"];
  const db = drizzle(env.DB);
  await insertUser(db, DEV_USER);
  await insertUser(db, { id: "other", email: "o@example.com", name: "O", avatarUrl: "" });
  const now = "2026-10-01T00:00:00.000Z";
  await insertNote(db, { id: "priv", userId: DEV_USER.id, title: "秘密/メモ", plainContent: "secret line", isPublic: false, now }, { current: KEY });
  await insertNote(db, { id: "pub", userId: DEV_USER.id, title: "Public", plainContent: "open line", isPublic: true, now }, { current: KEY });
  await insertNote(db, { id: "old", userId: DEV_USER.id, title: "Old", plainContent: "trashed line", isPublic: false, deletedAt: now, now }, { current: KEY });
  await insertNote(db, { id: "theirs", userId: "other", title: "Theirs", plainContent: "their line", isPublic: true, now }, { current: KEY });
  const call = (method: string, path: string) =>
    app.request(path, { method, headers: method === "GET" ? {} : { Origin: ORIGIN } }, env);
  /** An edit through NoteRoom, as the editor's commits make (and so back up). */
  const write = async (noteId: string, content: string) => {
    const room = noteRoom(env, noteId);
    const identity = { noteId, userId: DEV_USER.id };
    const snap = await room.snapshot(identity);
    if (!snap.ok) throw new Error("snapshot failed");
    const r = await room.replace(identity, { content, version: snap.value.version });
    if (!r.ok) throw new Error(JSON.stringify(r));
  };
  const text = async (noteId: string) => {
    const snap = await noteRoom(env, noteId).snapshot({ noteId, userId: DEV_USER.id });
    if (!snap.ok) throw new Error("snapshot failed");
    return documentToText(snap.value.model);
  };
  return { env, call, write, text };
}

describe("backups", () => {
  it("lists, previews and restores the owner's backups", async () => {
    const { call, write, text } = await setup();
    await write("priv", "edited line");

    const list = (await (await call("GET", "/api/notes/priv/backups")).json()) as { backups: { id: string; version: number }[] };
    expect(list.backups.map((b) => b.version)).toEqual([0]);
    const [backup] = list.backups;

    const preview = (await (await call("GET", `/api/notes/priv/backups/${backup.id}`)).json()) as { content: string; title: string };
    expect(preview.title).toBe("秘密/メモ");
    expect(preview.content).toContain("secret line");

    expect((await call("GET", "/notes/priv/history")).status).toBe(200);

    const restored = await call("POST", `/api/notes/priv/backups/${backup.id}/restore`);
    expect(restored.status).toBe(200);
    expect(await text("priv")).toContain("secret line");
  });

  it("is not found for other people's notes, trashed notes and unknown backups", async () => {
    const { call } = await setup();
    expect((await call("GET", "/api/notes/theirs/backups")).status).toBe(404);
    expect((await call("GET", "/api/notes/old/backups")).status).toBe(404);
    expect((await call("GET", "/notes/theirs/history")).status).toBe(404);
    expect((await call("GET", "/api/notes/priv/backups/nope")).status).toBe(404);
    expect((await call("POST", "/api/notes/priv/backups/nope/restore")).status).toBe(404);
    expect((await call("POST", "/api/notes/theirs/backups/nope/restore")).status).toBe(404);
  });

  it("refuses a restore from another site", async () => {
    const { env, write, call } = await setup();
    await write("priv", "edited line");
    const { backups } = (await (await call("GET", "/api/notes/priv/backups")).json()) as { backups: { id: string }[] };
    const res = await app.request(`/api/notes/priv/backups/${backups[0].id}/restore`, { method: "POST", headers: { Origin: "https://evil.example" } }, env);
    expect(res.status).toBe(403);
  });
});

describe("data export", () => {
  it("downloads every note of the user (decrypted, trash included) and nobody else's", async () => {
    const { call } = await setup();
    const res = await call("GET", "/api/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename="edane-export-\d{4}-\d{2}-\d{2}\.zip"$/);

    const decoder = new TextDecoder();
    const files = new Map(readZip(new Uint8Array(await res.arrayBuffer())).map((f) => [f.name, decoder.decode(f.data)]));
    expect([...files.keys()].sort()).toEqual(["notes.json", "notes/Public.md", "notes/秘密_メモ.md", "trash/Old.md"]);
    expect(files.get("notes/秘密_メモ.md")).toBe("# 秘密/メモ\n- 秘密/メモ\n  - secret line\n");

    const json = JSON.parse(files.get("notes.json")!) as { format: string; notes: { id: string; deletedAt: string | null; content: { version: number } }[] };
    expect(json.format).toBe("edane-export");
    expect(json.notes.map((n) => n.id).sort()).toEqual(["old", "priv", "pub"]);
    expect(json.notes.every((n) => n.content.version === 2)).toBe(true);
    expect(files.get("notes.json")).not.toContain("their line");
  });
});
