import { Hono } from "hono";
import { inertia } from "@hono/inertia";
import { googleAuth } from "@hono/oauth-providers/google";
import { drizzle } from "drizzle-orm/d1";
import { desc, eq } from "drizzle-orm";
import { rootView } from "./root-view";
import { users, notes, apiTokens } from "./db/schema";
import { getSession, setSession, clearSession } from "./utils/session";
import { getUserByToken, hashToken } from "./utils/apiToken";
import { encrypt, decrypt, isEncrypted } from "./utils/crypto";
import type { Env } from "./global.d";

const DEV_USER = {
  id: "dev-user",
  email: "dev@localhost",
  name: "Dev User",
  avatarUrl: "",
};

const app = new Hono<Env>();

// --- Session middleware (with dev bypass) ---
app.use("*", async (c, next) => {
  if (c.env.DEV_BYPASS_AUTH) {
    const db = drizzle(c.env.DB);
    const existing = await db
      .select()
      .from(users)
      .where(eq(users.id, DEV_USER.id))
      .get();
    if (!existing) {
      await db.insert(users).values({
        id: DEV_USER.id,
        email: DEV_USER.email,
        name: DEV_USER.name,
        avatarUrl: DEV_USER.avatarUrl,
      });
    }
    c.set("user", DEV_USER);
    return next();
  }
  // Session cookie first, then Bearer token (used by the desktop app)
  c.set("user", (await getSession(c)) || (await getUserByToken(c)));
  return next();
});

// --- Inertia middleware ---
app.use(inertia({ rootView }));

// --- Auth (full-page redirects, not Inertia) ---
app.get(
  "/auth/google",
  googleAuth({ scope: ["openid", "email", "profile"], prompt: "select_account" }),
  async (c) => {
    const googleUser = c.get("user-google");
    if (!googleUser?.email) return c.redirect("/notes?error=auth");

    const db = drizzle(c.env.DB);
    const existing = await db
      .select()
      .from(users)
      .where(eq(users.email, googleUser.email))
      .get();

    let userId: string;
    if (existing) {
      userId = existing.id;
      await db
        .update(users)
        .set({
          name: googleUser.name || existing.name,
          avatarUrl: googleUser.picture || existing.avatarUrl,
        })
        .where(eq(users.id, existing.id));
    } else {
      userId = crypto.randomUUID();
      await db.insert(users).values({
        id: userId,
        email: googleUser.email,
        name: googleUser.name || null,
        avatarUrl: googleUser.picture || null,
        createdAt: new Date().toISOString(),
      });
    }

    await setSession(c, {
      id: userId,
      email: googleUser.email,
      name: googleUser.name || "",
      avatarUrl: googleUser.picture || "",
    });

    return c.redirect("/notes");
  }
);

app.get("/auth/logout", (c) => {
  clearSession(c);
  return c.redirect("/notes");
});

// --- JSON API used by the editor for debounced autosave (not Inertia) ---
app.put("/api/notes/:id", async (c) => {
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

  const willBePublic = body.isPublic ?? note.isPublic;

  let contentToStore = body.content;
  if (contentToStore !== undefined && !willBePublic) {
    contentToStore = await encrypt(contentToStore, c.env.ENCRYPTION_KEY);
  }
  // public -> private: re-encrypt existing content
  if (body.isPublic === false && note.isPublic && contentToStore === undefined) {
    contentToStore = await encrypt(note.content, c.env.ENCRYPTION_KEY);
  }
  // private -> public: decrypt existing content
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

// --- API tokens (JSON; used by the desktop app via Bearer auth) ---
app.post("/api/tokens", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  const rawToken = `edane_${crypto.randomUUID().replace(/-/g, "")}`;
  const hash = await hashToken(rawToken);
  const id = crypto.randomUUID();

  const db = drizzle(c.env.DB);
  await db.insert(apiTokens).values({
    id,
    userId: user.id,
    name: body.name || "default",
    tokenHash: hash,
    createdAt: new Date().toISOString(),
  });

  // Return the raw token only once — it cannot be retrieved later
  return c.json({ id, token: rawToken, name: body.name || "default" }, 201);
});

app.get("/api/tokens", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const db = drizzle(c.env.DB);
  const tokens = await db
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      createdAt: apiTokens.createdAt,
    })
    .from(apiTokens)
    .where(eq(apiTokens.userId, user.id));

  return c.json(tokens);
});

app.delete("/api/tokens/:id", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const id = c.req.param("id");
  const db = drizzle(c.env.DB);

  const token = await db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.id, id))
    .get();
  if (!token || token.userId !== user.id) {
    return c.json({ error: "Not found" }, 404);
  }

  await db.delete(apiTokens).where(eq(apiTokens.id, id));
  return c.json({ ok: true });
});

// --- Inertia pages ---
const routes = app
  .get("/", (c) => c.redirect("/notes"))
  .get("/notes", async (c) => {
    const user = c.get("user");
    let myNotes: {
      id: string;
      title: string;
      isPublic: boolean;
      updatedAt: string;
    }[] = [];
    if (user) {
      const db = drizzle(c.env.DB);
      myNotes = await db
        .select({
          id: notes.id,
          title: notes.title,
          isPublic: notes.isPublic,
          updatedAt: notes.updatedAt,
        })
        .from(notes)
        .where(eq(notes.userId, user.id))
        .orderBy(desc(notes.updatedAt));
    }
    return c.render("Notes/Index", { user, notes: myNotes });
  })
  .get("/guest", (c) => c.render("Guest", { user: c.get("user") }))
  .get("/notes/new", (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/notes");
    return c.render("Notes/New", { user });
  })
  .post("/notes", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/notes");

    const body = await c.req
      .json<{ title?: string; isPublic?: boolean }>()
      .catch(() => ({}) as { title?: string; isPublic?: boolean });
    const isPublic = body.isPublic ?? false;
    const db = drizzle(c.env.DB);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const plain = "トピック1\nトピック2";
    // Public notes store plaintext; private notes are encrypted at rest
    const content = isPublic
      ? plain
      : await encrypt(plain, c.env.ENCRYPTION_KEY);

    await db.insert(notes).values({
      id,
      userId: user.id,
      title: body.title || "Untitled",
      content,
      isPublic,
      createdAt: now,
      updatedAt: now,
    });

    return c.redirect(`/notes/${id}/edit`, 303);
  })
  .delete("/notes/:id", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/notes");
    const db = drizzle(c.env.DB);
    const note = await db
      .select()
      .from(notes)
      .where(eq(notes.id, c.req.param("id")))
      .get();
    if (note && note.userId === user.id) {
      await db.delete(notes).where(eq(notes.id, note.id));
    }
    return c.redirect("/notes", 303);
  })
  .get("/notes/:id/edit", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/notes");
    const db = drizzle(c.env.DB);
    const note = await db
      .select()
      .from(notes)
      .where(eq(notes.id, c.req.param("id")))
      .get();
    if (!note || note.userId !== user.id) return c.notFound();

    let content = note.content;
    if (!note.isPublic && content && isEncrypted(content)) {
      try {
        content = await decrypt(content, c.env.ENCRYPTION_KEY);
      } catch {
        content = "";
      }
    }
    return c.render("Notes/Edit", {
      user,
      note: { id: note.id, title: note.title, content, isPublic: note.isPublic },
    });
  })
  .get("/notes/:id", async (c) => {
    const db = drizzle(c.env.DB);
    const note = await db
      .select()
      .from(notes)
      .where(eq(notes.id, c.req.param("id")))
      .get();
    const user = c.get("user");
    if (!note) return c.notFound();
    if (!note.isPublic && (!user || note.userId !== user.id)) {
      return c.notFound();
    }

    let content = note.content;
    if (!note.isPublic && content && isEncrypted(content)) {
      try {
        content = await decrypt(content, c.env.ENCRYPTION_KEY);
      } catch {
        return c.text("Decryption failed", 500);
      }
    }
    return c.render("Notes/Show", {
      user,
      note: { id: note.id, title: note.title, content, isPublic: note.isPublic },
    });
  });

export default routes;
