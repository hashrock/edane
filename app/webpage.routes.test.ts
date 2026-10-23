/**
 * Publishing a note as a web page (`/api/notes/:id/webpage`, `/w/:id`) through
 * the real app on the in-memory D1: only the owner's public notes publish, the
 * page is rendered from the live note with its own CSP, and it goes dark when
 * the note stops being public until its owner publishes again.
 */
import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import app from "./server";
import type { Env } from "./global.d";
import { sqliteD1 } from "../vitest.d1";
import { DEV_USER } from "./auth/bypassAuth";
import { insertNote } from "./utils/noteRepository";
import { insertUser } from "./utils/userRepository";
import { serializeDocument } from "./application/persistence";
import { DEFAULT_PAGE_THEME } from "./domain/pageTheme";

const KEY = "test-encryption-key";
const ORIGIN = "http://localhost";

async function setup() {
  const env = { DB: sqliteD1(), ENCRYPTION_KEY: KEY, SESSION_SECRET: "s", DEV_BYPASS_AUTH: "1" } as Env["Bindings"];
  const db = drizzle(env.DB);
  await insertUser(db, DEV_USER);
  await insertUser(db, { id: "other", email: "o@example.com", name: "O", avatarUrl: "" });
  const content = serializeDocument({
    title: "",
    theme: { ...DEFAULT_PAGE_THEME, accentColor: "#ff0000" },
    roots: [{ id: "r", text: "Hello", children: [{ id: "a", text: "Section", children: [{ id: "a1", text: "item", children: [] }] }] }],
  });
  const now = "2026-10-01T00:00:00.000Z";
  await insertNote(db, { id: "pub", userId: DEV_USER.id, title: "Public", plainContent: content, isPublic: true, now }, { current: KEY });
  await insertNote(db, { id: "priv", userId: DEV_USER.id, title: "Private", plainContent: content, isPublic: false, now }, { current: KEY });
  await insertNote(db, { id: "theirs", userId: "other", title: "Theirs", plainContent: content, isPublic: true, now }, { current: KEY });
  const call = (method: string, path: string) =>
    app.request(path, { method, headers: method === "GET" ? {} : { Origin: ORIGIN } }, env);
  return { env, call };
}

describe("web page publishing", () => {
  it("publishes a public note idempotently and serves it as themed HTML", async () => {
    const { call } = await setup();
    expect(await (await call("GET", "/api/notes/pub/webpage")).json()).toEqual({ publication: null });

    const first = await call("POST", "/api/notes/pub/webpage");
    expect(first.status).toBe(201);
    const { publication } = (await first.json()) as { publication: { id: string; active: boolean } };
    expect(publication.active).toBe(true);
    const again = (await (await call("POST", "/api/notes/pub/webpage")).json()) as { publication: { id: string } };
    expect(again.publication.id).toBe(publication.id);

    const page = await call("GET", `/w/${publication.id}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).toContain("<title>Public</title>");
    expect(html).toContain("Section");
    expect(html).toContain("--wp-accent:#ff0000");
  });

  it("refuses private notes and other people's notes", async () => {
    const { call } = await setup();
    expect((await call("POST", "/api/notes/priv/webpage")).status).toBe(400);
    expect((await call("POST", "/api/notes/theirs/webpage")).status).toBe(404);
    expect((await call("GET", "/api/notes/theirs/webpage")).status).toBe(404);
  });

  it("goes dark when the note is made private, and resumes only when published again", async () => {
    const { env, call } = await setup();
    const { publication } = (await (await call("POST", "/api/notes/pub/webpage")).json()) as { publication: { id: string } };
    await env.DB.prepare("UPDATE notes SET is_public = 0 WHERE id = 'pub'").run();
    await env.DB.prepare("UPDATE notes SET is_public = 1 WHERE id = 'pub'").run();
    expect((await call("GET", `/w/${publication.id}`)).status).toBe(404);
    expect(await (await call("GET", "/api/notes/pub/webpage")).json()).toEqual({ publication: { id: publication.id, active: false } });

    await call("POST", "/api/notes/pub/webpage");
    expect((await call("GET", `/w/${publication.id}`)).status).toBe(200);
  });

  it("unpublishing kills the URL; publishing again mints a new one", async () => {
    const { call } = await setup();
    const { publication } = (await (await call("POST", "/api/notes/pub/webpage")).json()) as { publication: { id: string } };
    expect(await (await call("DELETE", "/api/notes/pub/webpage")).json()).toEqual({ publication: null });
    expect((await call("GET", `/w/${publication.id}`)).status).toBe(404);
    const next = (await (await call("POST", "/api/notes/pub/webpage")).json()) as { publication: { id: string } };
    expect(next.publication.id).not.toBe(publication.id);
  });

  it("refuses cross-origin writes", async () => {
    const { env } = await setup();
    const res = await app.request("/api/notes/pub/webpage", { method: "POST", headers: { Origin: "https://evil.example" } }, env);
    expect(res.status).toBe(403);
  });
});
