/** NoteRoom's UPDATE bumps public_epoch exactly when a note goes from public to private. */
import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../global.d";
import { sqliteD1 } from "../../vitest.d1";
import { insertUser } from "../utils/userRepository";
import { insertNote } from "../utils/noteRepository";
import { NoteRoom } from "./room";

const KEY = "test-encryption-key";

describe("NoteRoom public_epoch", () => {
  it("advances on public → private only", async () => {
    const env = { DB: sqliteD1(), ENCRYPTION_KEY: KEY } as Env["Bindings"];
    const db = drizzle(env.DB);
    await insertUser(db, { id: "u", email: "u@example.com", name: "U", avatarUrl: "" });
    await insertNote(db, { id: "n", userId: "u", title: "T", plainContent: "a", isPublic: true, now: "2026-01-01" }, { current: KEY });
    const room = new NoteRoom({ getWebSockets: () => [] } as unknown as DurableObjectState, env);
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
});
