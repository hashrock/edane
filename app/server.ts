import { Hono } from "hono";
import { inertia } from "@hono/inertia";
import { googleAuth } from "@hono/oauth-providers/google";
import { drizzle } from "drizzle-orm/d1";
import { and, desc, eq, isNull, isNotNull } from "drizzle-orm";
import { rootView } from "./root-view";
import { users, notes, apiTokens, images } from "./db/schema";
import { getSession, setSession, clearSession } from "./utils/session";
import { getUserByToken } from "./utils/apiToken";
import { hashToken } from "./utils/tokenHash";
import { encrypt, decrypt, isEncrypted } from "./utils/crypto";
import { resolveDevGuestPreference } from "./utils/devAuthBypass";
import type { Env } from "./global.d";

const DEV_USER = {
  id: "dev-user",
  email: "dev@localhost",
  name: "Dev User",
  avatarUrl: "",
};

// Per-user image storage quota (bytes).
const STORAGE_LIMIT = 10 * 1024 * 1024; // 10MB

const app = new Hono<Env>();

// --- Session middleware (with dev bypass) ---
app.use("*", async (c, next) => {
  if (c.env.DEV_BYPASS_AUTH) {
    // Dev-only: preview the logged-out landing page while auth is bypassed.
    // `?guest=1` flips into guest mode (persisted in a cookie so the LP's
    // embedded /guest iframe is guest too); `?guest=0` flips back to Dev User.
    const { guest, setCookieHeader } = resolveDevGuestPreference(
      c.req.header("Cookie") || "",
      new URL(c.req.url).searchParams.get("guest")
    );
    if (setCookieHeader) c.header("Set-Cookie", setCookieHeader);
    if (guest) {
      c.set("user", null);
      return next();
    }
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
    if (!googleUser?.email) return c.redirect("/?error=auth");

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
  return c.redirect("/");
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

// --- Images: R2 upload + D1 metadata (JSON; used by the editor & settings) ---
app.get("/api/images", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = drizzle(c.env.DB);
  const rows = await db
    .select()
    .from(images)
    .where(eq(images.userId, user.id))
    .orderBy(desc(images.createdAt));
  const used = rows.reduce((sum, r) => sum + r.size, 0);
  return c.json({
    images: rows.map((r) => ({
      id: r.id,
      url: `/api/images/${r.id}/raw`,
      filename: r.filename,
      contentType: r.contentType,
      size: r.size,
      createdAt: r.createdAt,
    })),
    used,
    limit: STORAGE_LIMIT,
  });
});

app.post("/api/images", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "No file provided" }, 400);
  }
  if (!file.type.startsWith("image/")) {
    return c.json({ error: "Only image files are allowed" }, 400);
  }

  const db = drizzle(c.env.DB);
  const existing = await db
    .select({ size: images.size })
    .from(images)
    .where(eq(images.userId, user.id));
  const used = existing.reduce((sum, r) => sum + r.size, 0);
  if (used + file.size > STORAGE_LIMIT) {
    return c.json(
      { error: "Storage limit exceeded", used, limit: STORAGE_LIMIT, fileSize: file.size },
      413
    );
  }

  const id = crypto.randomUUID();
  const r2Key = `${user.id}/${id}`;
  await c.env.IMAGES.put(r2Key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type },
  });

  const createdAt = new Date().toISOString();
  await db.insert(images).values({
    id,
    userId: user.id,
    r2Key,
    filename: file.name,
    contentType: file.type,
    size: file.size,
    createdAt,
  });

  return c.json(
    {
      id,
      url: `/api/images/${id}/raw`,
      filename: file.name,
      contentType: file.type,
      size: file.size,
      createdAt,
    },
    201
  );
});

app.delete("/api/images/:id", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  const meta = await db.select().from(images).where(eq(images.id, id)).get();
  if (!meta || meta.userId !== user.id) {
    return c.json({ error: "Not found" }, 404);
  }
  await c.env.IMAGES.delete(meta.r2Key);
  await db.delete(images).where(eq(images.id, id));
  return c.json({ ok: true });
});

// Serve the binary. Public (no auth) so it works inside public notes / <img>.
app.get("/api/images/:id/raw", async (c) => {
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  const meta = await db.select().from(images).where(eq(images.id, id)).get();
  if (!meta) return c.notFound();
  const obj = await c.env.IMAGES.get(meta.r2Key);
  if (!obj) return c.notFound();
  return new Response(obj.body, {
    headers: {
      "Content-Type": meta.contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
});

// --- Link preview: server-side fetch of <title> + favicon (avoids CORS) ---
app.get("/api/link-preview", async (c) => {
  const url = c.req.query("url");
  if (!url) return c.json({ error: "url is required" }, 400);
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return c.json({ error: "invalid url" }, 400);
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return c.json({ error: "unsupported protocol" }, 400);
  }
  try {
    const res = await fetch(target.toString(), {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; edane-bot/1.0)" },
      redirect: "follow",
    });
    const html = await res.text();
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch
      ? titleMatch[1].replace(/\s+/g, " ").trim().slice(0, 300)
      : target.hostname;

    let favicon: string | null = null;
    for (const tag of html.match(/<link[^>]+>/gi) ?? []) {
      if (/rel=["'][^"']*icon[^"']*["']/i.test(tag)) {
        const href = tag.match(/href=["']([^"']+)["']/i);
        if (href) {
          favicon = new URL(href[1], target).toString();
          break;
        }
      }
    }
    if (!favicon) favicon = `${target.protocol}//${target.host}/favicon.ico`;

    return c.json({ title, favicon });
  } catch (e) {
    return c.json({ error: "fetch failed", detail: String(e) }, 502);
  }
});

// --- Inertia pages ---
const routes = app
  // Root is the signed-out landing page (with the embedded guest editor).
  // Signed-in visitors belong in their note list at /notes.
  .get("/", (c) => {
    const user = c.get("user");
    if (user) return c.redirect("/notes");
    return c.render("Notes/Index", { user: null, notes: [] });
  })
  .get("/notes", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/");
    const db = drizzle(c.env.DB);
    const myNotes = await db
      .select({
        id: notes.id,
        title: notes.title,
        isPublic: notes.isPublic,
        pinned: notes.pinned,
        updatedAt: notes.updatedAt,
      })
      .from(notes)
      // Exclude trashed notes; they live on the /trash page.
      .where(and(eq(notes.userId, user.id), isNull(notes.deletedAt)))
      // Pinned notes float to the top; ties (and everything else) fall back to
      // most-recently-updated.
      .orderBy(desc(notes.pinned), desc(notes.updatedAt));
    return c.render("Notes/Index", { user, notes: myNotes });
  })
  .get("/trash", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/");
    const db = drizzle(c.env.DB);
    const trashed = await db
      .select({
        id: notes.id,
        title: notes.title,
        isPublic: notes.isPublic,
        deletedAt: notes.deletedAt,
        updatedAt: notes.updatedAt,
      })
      .from(notes)
      .where(and(eq(notes.userId, user.id), isNotNull(notes.deletedAt)))
      .orderBy(desc(notes.deletedAt));
    return c.render("Notes/Trash", { user, notes: trashed });
  })
  .get("/settings", (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/");
    return c.render("Settings", { user });
  })
  .get("/guest", (c) =>
    c.render("Guest", {
      user: c.get("user"),
      // Embedded (iframe) guest editor: hides the nav header so it drops
      // cleanly into the landing page.
      embed: c.req.query("embed") === "1",
    })
  )
  .get("/notes/new", (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/");
    return c.render("Notes/New", { user });
  })
  .post("/notes", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/");

    const body = await c.req
      .json<{ title?: string; isPublic?: boolean; content?: string }>()
      .catch(() => ({}) as { title?: string; isPublic?: boolean; content?: string });
    const isPublic = body.isPublic ?? false;
    const db = drizzle(c.env.DB);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    // Guest-mode imports arrive with their own serialized content; a plain
    // "new note" falls back to the starter topics.
    const plain = body.content ?? "トピック1\nトピック2";
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
  .post("/notes/:id/trash", async (c) => {
    // Soft delete: move to the trash (restorable). The main list hides it.
    const user = c.get("user");
    if (!user) return c.redirect("/");
    const db = drizzle(c.env.DB);
    const note = await db
      .select()
      .from(notes)
      .where(eq(notes.id, c.req.param("id")))
      .get();
    if (note && note.userId === user.id) {
      await db
        .update(notes)
        .set({ deletedAt: new Date().toISOString() })
        .where(eq(notes.id, note.id));
    }
    return c.redirect("/notes", 303);
  })
  .post("/notes/:id/restore", async (c) => {
    // Bring a trashed note back to the main list.
    const user = c.get("user");
    if (!user) return c.redirect("/");
    const db = drizzle(c.env.DB);
    const note = await db
      .select()
      .from(notes)
      .where(eq(notes.id, c.req.param("id")))
      .get();
    if (note && note.userId === user.id) {
      await db
        .update(notes)
        .set({ deletedAt: null })
        .where(eq(notes.id, note.id));
    }
    return c.redirect("/trash", 303);
  })
  .delete("/notes/:id", async (c) => {
    // Permanent delete (from the trash page). Irreversible.
    const user = c.get("user");
    if (!user) return c.redirect("/");
    const db = drizzle(c.env.DB);
    const note = await db
      .select()
      .from(notes)
      .where(eq(notes.id, c.req.param("id")))
      .get();
    if (note && note.userId === user.id) {
      await db.delete(notes).where(eq(notes.id, note.id));
    }
    return c.redirect("/trash", 303);
  })
  .post("/notes/:id/pin", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/");
    const db = drizzle(c.env.DB);
    const note = await db
      .select()
      .from(notes)
      .where(eq(notes.id, c.req.param("id")))
      .get();
    if (note && note.userId === user.id) {
      const body = await c.req
        .json<{ pinned?: boolean }>()
        .catch(() => ({}) as { pinned?: boolean });
      const pinned = body.pinned ?? !note.pinned;
      await db.update(notes).set({ pinned }).where(eq(notes.id, note.id));
    }
    return c.redirect("/notes", 303);
  })
  .get("/notes/:id/edit", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/");
    const db = drizzle(c.env.DB);
    const note = await db
      .select()
      .from(notes)
      .where(eq(notes.id, c.req.param("id")))
      .get();
    if (!note || note.userId !== user.id || note.deletedAt) return c.notFound();

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
    if (!note || note.deletedAt) return c.notFound();
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
