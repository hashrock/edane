/** Automatic backups (application/noteBackups.ts) as NoteRoom writes them, and restoring one. */
import { describe, it, expect, vi, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../global.d";
import { seededD1, testRoom } from "../../vitest.d1";
import { insertNote } from "../utils/noteRepository";
import { BACKUP_INTERVAL_MS, MAX_BACKUPS_PER_NOTE } from "../application/noteBackups";
import { documentToText } from "../application/persistence";

const KEY = "test-encryption-key";
const identity = { noteId: "n", userId: "u" };

async function setup(isPublic = false) {
  const env = { DB: await seededD1(), ENCRYPTION_KEY: KEY } as Env["Bindings"];
  await insertNote(drizzle(env.DB), { id: "n", userId: "u", title: "T", plainContent: "first", isPublic, now: "2026-01-01" }, { current: KEY });
  const room = testRoom(env);
  /** Replace the note's text through the legacy full-document path (an ordinary commit). */
  const write = async (content: string) => {
    const snap = await room.snapshot(identity);
    if (!snap.ok) throw new Error("snapshot failed");
    const r = await room.replace(identity, { content, version: snap.value.version });
    if (!r.ok) throw new Error(JSON.stringify(r));
  };
  const backups = () =>
    env.DB.prepare("SELECT id, title, content, version FROM note_backups WHERE note_id = 'n' ORDER BY created_at, id")
      .all<{ id: string; title: string; content: string; version: number }>()
      .then((r) => r.results);
  const text = async () => {
    const snap = await room.snapshot(identity);
    if (!snap.ok) throw new Error("snapshot failed");
    return documentToText(snap.value.model);
  };
  return { env, room, write, backups, text };
}

afterEach(() => vi.useRealTimers());

describe("NoteRoom automatic backups", () => {
  it("backs up the state before the first commit, then at most once per interval", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-03-01T00:00:00Z") });
    const { write, backups } = await setup();
    await write("second");
    await write("third");
    expect((await backups()).map((b) => b.version)).toEqual([0]);

    vi.setSystemTime(Date.now() + BACKUP_INTERVAL_MS);
    await write("fourth");
    expect((await backups()).map((b) => b.version)).toEqual([0, 2]);
  });

  it("stores backups encrypted even for a public note", async () => {
    const { write, backups } = await setup(true);
    await write("second");
    const [b] = await backups();
    expect(b.content.startsWith("v2:")).toBe(true);
    expect(b.content).not.toContain("first");
  });

  it("keeps only the newest backups", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-03-01T00:00:00Z") });
    const { write, backups } = await setup();
    for (let i = 0; i < MAX_BACKUPS_PER_NOTE + 3; i++) {
      await write(`v${i}`);
      vi.setSystemTime(Date.now() + BACKUP_INTERVAL_MS);
    }
    const kept = await backups();
    expect(kept).toHaveLength(MAX_BACKUPS_PER_NOTE);
    expect(kept.at(-1)!.version).toBe(MAX_BACKUPS_PER_NOTE + 2);
  });

  it("restores a backup as a commit, backing up the replaced state first", async () => {
    const { room, write, backups, text } = await setup();
    await write("second");
    const [first] = await backups();

    const r = await room.restore(identity, first.id);
    expect(r.ok).toBe(true);
    expect(await text()).toBe("T\n  first");
    // The replaced "second" is now in the history, so the restore can be undone.
    const after = await backups();
    expect(after).toHaveLength(2);
    const undo = await room.restore(identity, after[1].id);
    expect(undo.ok).toBe(true);
    expect(await text()).toBe("T\n  second");
  });

  it("refuses another note's backup and other users", async () => {
    const { env, room, write, backups } = await setup();
    await write("second");
    const [b] = await backups();
    await insertNote(drizzle(env.DB), { id: "m", userId: "u", title: "M", plainContent: "x", isPublic: false, now: "2026-01-01" }, { current: KEY });
    expect(await room.restore({ noteId: "m", userId: "u" }, b.id)).toMatchObject({ ok: false, code: "not-found" });
    expect(await room.restore({ noteId: "n", userId: "other" }, b.id)).toMatchObject({ ok: false, code: "not-found" });
  });

  it("goes away with the note", async () => {
    const { env, write, backups } = await setup();
    await write("second");
    await env.DB.prepare("DELETE FROM notes WHERE id = 'n'").run();
    expect(await backups()).toEqual([]);
  });
});
