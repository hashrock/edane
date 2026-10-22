/** public_epoch (the notes_public_epoch trigger) advances exactly when a note stops being servable, whoever writes it. */
import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../global.d";
import { seededD1, testRoom } from "../../vitest.d1";
import { insertNote } from "../utils/noteRepository";

const KEY = "test-encryption-key";

describe("NoteRoom public_epoch", () => {
  it("advances on public → private only", async () => {
    const env = { DB: await seededD1(), ENCRYPTION_KEY: KEY } as Env["Bindings"];
    const db = drizzle(env.DB);
    await insertNote(db, { id: "n", userId: "u", title: "T", plainContent: "a", isPublic: true, now: "2026-01-01" }, { current: KEY });
    const room = testRoom(env);
    const identity = { noteId: "n", userId: "u" };
    const epoch = async () => (await env.DB.prepare("SELECT public_epoch FROM notes WHERE id = 'n'").first<number>("public_epoch"));
    const setPublic = async (isPublic: boolean) => {
      const snap = await room.snapshot(identity);
      if (!snap.ok) throw new Error("snapshot failed");
      const r = await room.replace(identity, { isPublic, version: snap.value.version });
      if (!r.ok) throw new Error(JSON.stringify(r));
    };

    await setPublic(true); // public → public
    expect(await epoch()).toBe(0);
    await setPublic(false); // public → private
    expect(await epoch()).toBe(1);
    await setPublic(false); // private → private
    expect(await epoch()).toBe(1);
    await setPublic(true); // private → public: old publications stay dead
    expect(await epoch()).toBe(1);
    await setPublic(false);
    expect(await epoch()).toBe(2);
  });

  it("advances when a public note is trashed, not when it's restored", async () => {
    const env = { DB: await seededD1() } as Env["Bindings"];
    const db = drizzle(env.DB);
    await insertNote(db, { id: "n", userId: "u", title: "T", plainContent: "a", isPublic: true, now: "2026-01-01" }, { current: KEY });
    const epoch = async () => await env.DB.prepare("SELECT public_epoch FROM notes WHERE id = 'n'").first<number>("public_epoch");
    await env.DB.prepare("UPDATE notes SET deleted_at = 'x' WHERE id = 'n'").run();
    expect(await epoch()).toBe(1);
    await env.DB.prepare("UPDATE notes SET deleted_at = NULL WHERE id = 'n'").run();
    expect(await epoch()).toBe(1);
  });
});
