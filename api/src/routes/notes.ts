import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { notes } from "../db/schema";
import { desc, eq } from "drizzle-orm";
import { getSession } from "../utils/session";
import { encrypt, decrypt, isEncrypted } from "../utils/crypto";
import type { Env } from "../global.d";

const notesApi = new Hono<Env>();

// GET /api/notes/my — list current user's notes
notesApi.get("/my", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const db = drizzle(c.env.DB);
  const myNotes = await db
    .select()
    .from(notes)
    .where(eq(notes.userId, user.id))
    .orderBy(desc(notes.updatedAt));

  // Decrypt private notes' content
  const decrypted = await Promise.all(
    myNotes.map(async (n) => {
      if (!n.isPublic && n.content && isEncrypted(n.content)) {
        try {
          return { ...n, content: await decrypt(n.content, c.env.ENCRYPTION_KEY) };
        } catch {
          return { ...n, content: "" };
        }
      }
      return n;
    })
  );

  return c.json(decrypted);
});

// GET /api/notes/:id — get a single note
notesApi.get("/:id", async (c) => {
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  const note = await db.select().from(notes).where(eq(notes.id, id)).get();

  if (!note) return c.json({ error: "Not found" }, 404);

  const user = c.get("user");
  if (!note.isPublic && (!user || note.userId !== user.id)) {
    return c.json({ error: "Not found" }, 404);
  }

  // Decrypt private note content
  if (!note.isPublic && note.content && isEncrypted(note.content)) {
    try {
      note.content = await decrypt(note.content, c.env.ENCRYPTION_KEY);
    } catch {
      return c.json({ error: "Decryption failed" }, 500);
    }
  }

  return c.json(note);
});

// POST /api/notes — create a note
notesApi.post("/", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json<{
    title?: string;
    content?: string;
    isPublic?: boolean;
  }>();
  const db = drizzle(c.env.DB);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const isPublic = body.isPublic ?? false;
  const rawContent = body.content || "トピック1\nトピック2";
  const content = isPublic
    ? rawContent
    : await encrypt(rawContent, c.env.ENCRYPTION_KEY);

  await db.insert(notes).values({
    id,
    userId: user.id,
    title: body.title || "Untitled",
    content,
    isPublic,
    createdAt: now,
    updatedAt: now,
  });

  return c.json({ id }, 201);
});

// PUT /api/notes/:id — update a note
notesApi.put("/:id", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const id = c.req.param("id");
  const db = drizzle(c.env.DB);

  const note = await db.select().from(notes).where(eq(notes.id, id)).get();
  if (!note || note.userId !== user.id) {
    return c.json({ error: "Not found" }, 404);
  }

  const body = await c.req.json<{
    title?: string;
    content?: string;
    isPublic?: boolean;
  }>();

  // Determine final public state (use existing if not in body)
  const willBePublic = body.isPublic ?? note.isPublic;

  // Encrypt content for private notes
  let contentToStore = body.content;
  if (contentToStore !== undefined && !willBePublic) {
    contentToStore = await encrypt(contentToStore, c.env.ENCRYPTION_KEY);
  }

  // If toggling public→private, re-encrypt existing content
  if (body.isPublic === false && note.isPublic && contentToStore === undefined) {
    contentToStore = await encrypt(note.content, c.env.ENCRYPTION_KEY);
  }

  // If toggling private→public, decrypt existing content
  if (body.isPublic === true && !note.isPublic && contentToStore === undefined) {
    if (isEncrypted(note.content)) {
      contentToStore = await decrypt(note.content, c.env.ENCRYPTION_KEY);
    }
  }

  await db
    .update(notes)
    .set({
      ...(body.title !== undefined && { title: body.title }),
      ...(contentToStore !== undefined && { content: contentToStore }),
      ...(body.isPublic !== undefined && { isPublic: body.isPublic }),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(notes.id, id));

  return c.json({ ok: true });
});

// DELETE /api/notes/:id
notesApi.delete("/:id", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const id = c.req.param("id");
  const db = drizzle(c.env.DB);

  const note = await db.select().from(notes).where(eq(notes.id, id)).get();
  if (!note || note.userId !== user.id) {
    return c.json({ error: "Not found" }, 404);
  }

  await db.delete(notes).where(eq(notes.id, id));
  return c.json({ ok: true });
});

export { notesApi };
