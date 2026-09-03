import { Hono } from "hono";
import { cors } from "hono/cors";
import { inertia } from "@hono/inertia";
import { googleAuth } from "@hono/oauth-providers/google";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, desc, eq, isNull, isNotNull } from "drizzle-orm";
import { rootView } from "./root-view";
import { users, notes, apiTokens, images, nodePublications, sites } from "./db/schema";
import { getSession, setSession, clearSession } from "./utils/session";
import { getUserByToken } from "./utils/apiToken";
import { hashToken } from "./utils/tokenHash";
import { encrypt, decrypt, isEncrypted, decodeStoredNoteContent, encodeNoteContentForStorage, noteStorageMode } from "./utils/crypto";
import { resolveDevGuestPreference } from "./utils/devAuthBypass";
import { resolveNoteContentAction } from "./utils/noteContentTransition";
import { resolveEditPageAccess, resolveViewPageAccess } from "./utils/noteAccess";
import { loadOwnedNote } from "./utils/noteOwnership";
import { assertNever } from "./lib/assertNever";
import { findNode } from "./domain/model";
import { parseContent } from "./application/persistence";
import { modelToMarkdown } from "./application/markdown";
import {
  PRIVATE_NOTE_PUBLISH_REASON,
  parsePublicationPath,
  canServePublication,
  publishedNodeJson,
  nodePathTexts,
} from "./application/nodePublication";
import { renderSiteResponse, validateSiteSave } from "./application/siteTemplate";
import { toSiteNode } from "./application/siteNode";
import { defaultTemplate } from "./application/siteSchema";
import {
  SITE_AI_MODEL,
  buildSuggestMessages,
  extractTemplate,
  validateSuggestRequest,
  effectiveSchema,
} from "./application/siteAi";
import { extractLinkPreview } from "./utils/linkPreview";
import { IMAGE_STORAGE_LIMIT_BYTES, totalImageBytes, exceedsImageQuota } from "./domain/imageStorage";
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

  const note = await loadOwnedNote(db, id, user.id);
  if (!note) {
    return c.json({ error: "Not found" }, 404);
  }

  const body = await c.req.json<{
    title?: string;
    content?: string;
    isPublic?: boolean;
  }>();

  const action = resolveNoteContentAction({
    currentIsPublic: note.isPublic,
    currentContent: note.content,
    requestedIsPublic: body.isPublic,
    requestedContent: body.content,
  });

  let contentToStore: string | undefined;
  switch (action.kind) {
    case "store-plain":
      contentToStore = action.content;
      break;
    case "encrypt":
      contentToStore = await encrypt(action.content, c.env.ENCRYPTION_KEY);
      break;
    case "decrypt-if-encrypted":
      contentToStore = isEncrypted(action.content)
        ? await decrypt(action.content, c.env.ENCRYPTION_KEY)
        : undefined;
      break;
    case "unchanged":
      contentToStore = undefined;
      break;
    default:
      assertNever(action);
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
  const used = totalImageBytes(rows.map((r) => r.size));
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
    limit: IMAGE_STORAGE_LIMIT_BYTES,
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
  const used = totalImageBytes(existing.map((r) => r.size));
  if (exceedsImageQuota(used, file.size)) {
    return c.json(
      { error: "Storage limit exceeded", used, limit: IMAGE_STORAGE_LIMIT_BYTES, fileSize: file.size },
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

// --- Node publications: serve one branch as JSON / Markdown (public, CORS) ---
// The slug is a random, revocable id (see application/nodePublication.ts for
// the policy). Content is always the LIVE subtree: the node gone, the note
// trashed or switched back to private all turn the URL into a 404. Data-feed
// endpoints, so keep crawlers out via X-Robots-Tag.
app.use("/pub/*", cors());
// --- Publication lookups (server-only: they combine db rows with the
// domain/application tree helpers, which the utils layer can't import) ---

/**
 * Public serve path: publication → its note → the live node. Only live public
 * notes are served — private notes stay encrypted and this never touches the
 * decryption path. Shared by /pub/:file and /sites/:pubId.
 */
async function loadServablePublication(db: DrizzleD1Database, pubId: string) {
  const pub = await db
    .select()
    .from(nodePublications)
    .where(eq(nodePublications.id, pubId))
    .get();
  if (!pub) return null;
  const note = await db.select().from(notes).where(eq(notes.id, pub.noteId)).get();
  if (!note || !canServePublication(note)) return null;
  const node = findNode(parseContent(note.content, note.title), pub.nodeId);
  return node ? { pub, note, node } : null;
}

/** A publication only if `userId` owns it — otherwise null (= not found). */
async function loadOwnedPublication(db: DrizzleD1Database, pubId: string, userId: string) {
  const pub = await db
    .select()
    .from(nodePublications)
    .where(eq(nodePublications.id, pubId))
    .get();
  return pub && pub.userId === userId ? pub : null;
}

/**
 * Owner path: publication → owned note (decoded the owner-facing way, so a
 * private note still resolves) → node. Used by the site editor and the AI
 * suggestion, which both need the branch's content.
 */
async function loadOwnedPublicationNode(
  db: DrizzleD1Database,
  pubId: string,
  userId: string,
  encryptionKey: string
) {
  const pub = await loadOwnedPublication(db, pubId, userId);
  if (!pub) return { error: "not-found" as const };
  const note = await loadOwnedNote(db, pub.noteId, userId);
  if (!note) return { error: "not-found" as const };
  const content = await decodeStoredNoteContent(
    note.content,
    noteStorageMode(note.isPublic),
    encryptionKey
  );
  if (content === null) return { error: "decrypt" as const };
  const node = findNode(parseContent(content, note.title), pub.nodeId);
  if (!node) return { error: "not-found" as const };
  return { pub, note, node };
}

app.get("/pub/:file", async (c) => {
  const parsed = parsePublicationPath(c.req.param("file"));
  if (!parsed) return c.notFound();

  const live = await loadServablePublication(drizzle(c.env.DB), parsed.pubId);
  if (!live) return c.notFound();
  const { node } = live;

  c.header("X-Robots-Tag", "noindex");
  if (parsed.format === "json") return c.json(publishedNodeJson(node));
  return c.text(modelToMarkdown(node), 200, {
    "Content-Type": "text/markdown; charset=utf-8",
  });
});

// Publish a node of an owned, public note. Idempotent per (note, node): the
// existing slug is returned rather than a second one minted, so "公開…" opened
// twice shows the same URL. Revoke + re-publish DOES mint a new slug — that's
// the URL-rotation feature, not an accident.
app.post("/api/notes/:id/publications", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const db = drizzle(c.env.DB);
  const note = await loadOwnedNote(db, c.req.param("id"), user.id);
  if (!note) return c.json({ error: "Not found" }, 404);
  if (!note.isPublic) {
    return c.json({ error: PRIVATE_NOTE_PUBLISH_REASON }, 400);
  }

  const body = await c.req
    .json<{ nodeId?: string }>()
    .catch(() => ({}) as { nodeId?: string });
  if (!body.nodeId) return c.json({ error: "nodeId is required" }, 400);
  if (!findNode(parseContent(note.content, note.title), body.nodeId)) {
    return c.json({ error: "Node not found" }, 404);
  }

  const existing = await db
    .select()
    .from(nodePublications)
    .where(
      and(
        eq(nodePublications.noteId, note.id),
        eq(nodePublications.nodeId, body.nodeId)
      )
    )
    .get();
  if (existing) {
    return c.json({
      id: existing.id,
      nodeId: existing.nodeId,
      createdAt: existing.createdAt,
    });
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await db.insert(nodePublications).values({
    id,
    userId: user.id,
    noteId: note.id,
    nodeId: body.nodeId,
    createdAt,
  });
  return c.json({ id, nodeId: body.nodeId, createdAt }, 201);
});

// List the current user's publications for the settings page: note title +
// the branch's root-to-node path (階層), plus why an inactive one is inactive.
// Decoding here is owner-facing (same as the edit page), so a note that went
// back to private still shows its path — the PUBLIC serve path above never
// decrypts.
app.get("/api/publications", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const db = drizzle(c.env.DB);
  const rows = await db
    .select({
      id: nodePublications.id,
      noteId: nodePublications.noteId,
      nodeId: nodePublications.nodeId,
      createdAt: nodePublications.createdAt,
      noteTitle: notes.title,
      noteContent: notes.content,
      noteIsPublic: notes.isPublic,
      noteDeletedAt: notes.deletedAt,
    })
    .from(nodePublications)
    .innerJoin(notes, eq(nodePublications.noteId, notes.id))
    .where(eq(nodePublications.userId, user.id))
    .orderBy(desc(nodePublications.createdAt));

  // Parse each note's tree once even when several branches of it are published.
  const models = new Map<string, ReturnType<typeof parseContent> | null>();
  const publications = [];
  for (const r of rows) {
    let model = models.get(r.noteId);
    if (model === undefined) {
      const content = await decodeStoredNoteContent(
        r.noteContent,
        noteStorageMode(r.noteIsPublic),
        c.env.ENCRYPTION_KEY
      );
      model = content === null ? null : parseContent(content, r.noteTitle);
      models.set(r.noteId, model);
    }
    const path = model ? nodePathTexts(model, r.nodeId) : null;
    const servable = canServePublication({
      isPublic: r.noteIsPublic,
      deletedAt: r.noteDeletedAt,
    });
    publications.push({
      id: r.id,
      noteId: r.noteId,
      nodeId: r.nodeId,
      createdAt: r.createdAt,
      noteTitle: r.noteTitle,
      path,
      active: servable && path !== null,
      inactiveReason: r.noteDeletedAt
        ? "note-trashed"
        : !r.noteIsPublic
          ? "note-private"
          : path === null
            ? "node-missing"
            : null,
    });
  }
  return c.json({ publications });
});

app.delete("/api/publications/:id", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  if (!(await loadOwnedPublication(db, id, user.id))) {
    return c.json({ error: "Not found" }, 404);
  }
  await db.delete(nodePublications).where(eq(nodePublications.id, id));
  return c.json({ ok: true });
});

// --- Sites: a JSX-templated static page per node publication ---

app.get("/sites/:pubId", async (c) => {
  const db = drizzle(c.env.DB);
  const pubId = c.req.param("pubId");
  const [live, site] = await Promise.all([
    loadServablePublication(db, pubId),
    db.select({ html: sites.html, css: sites.css }).from(sites).where(eq(sites.publicationId, pubId)).get(),
  ]);
  if (!live || !site) return c.notFound();
  const { body, headers } = renderSiteResponse(site, live.node.text);
  return c.body(body, 200, headers);
});

// Save (upsert) the template + build. The build is produced in the author's
// browser; the server only checks ownership and size — the serve path's CSP
// is what makes arbitrary author HTML safe on this origin.
app.put("/api/sites/:pubId", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = drizzle(c.env.DB);
  const pubId = c.req.param("pubId");
  if (!(await loadOwnedPublication(db, pubId, user.id))) {
    return c.json({ error: "Not found" }, 404);
  }

  const parsed = validateSiteSave(await c.req.json().catch(() => null));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  const updatedAt = new Date().toISOString();
  const row = {
    template: parsed.template,
    schema: parsed.schema,
    html: parsed.build.html,
    css: parsed.build.css,
    updatedAt,
  };
  await db
    .insert(sites)
    .values({ publicationId: pubId, userId: user.id, ...row })
    .onConflictDoUpdate({ target: sites.publicationId, set: row });
  return c.json({ ok: true, updatedAt });
});

// Ask Workers AI for a template tailored to the branch's data. Owner-only.
// The result is just text — the author's browser compiles it and shows
// errors like any hand edit.
app.post("/api/sites/:pubId/suggest", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const [owned, body] = await Promise.all([
    loadOwnedPublicationNode(drizzle(c.env.DB), c.req.param("pubId"), user.id, c.env.ENCRYPTION_KEY),
    c.req.json().catch(() => null),
  ]);
  if ("error" in owned) {
    return owned.error === "decrypt"
      ? c.json({ error: "Decryption failed" }, 500)
      : c.json({ error: "Not found" }, 404);
  }
  const request = validateSuggestRequest(body);
  const messages = buildSuggestMessages({ data: toSiteNode(owned.node), ...request });
  try {
    // The model sometimes stops mid-file (unclosed fence / finish_reason
    // "length"). One retry covers most of those; a second failure is reported.
    let last: ReturnType<typeof extractTemplate> = { kind: "none" };
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = (await c.env.AI.run(SITE_AI_MODEL, {
        messages,
        max_tokens: 4096,
      })) as { response?: string; choices?: { finish_reason?: string }[] };
      last = extractTemplate(result.response ?? "", {
        truncated: result.choices?.[0]?.finish_reason === "length",
      });
      if (last.kind === "ok") return c.json({ template: last.template });
    }
    return c.json(
      { error: last.kind === "truncated" ? "AI response was cut off" : "AI returned no template" },
      502
    );
  } catch (e) {
    return c.json({ error: "AI request failed", detail: String(e) }, 502);
  }
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
    return c.json(extractLinkPreview(html, target));
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
    const content = await encodeNoteContentForStorage(plain, noteStorageMode(isPublic), c.env.ENCRYPTION_KEY);

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
    const note = await loadOwnedNote(db, c.req.param("id"), user.id);
    if (note) {
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
    const note = await loadOwnedNote(db, c.req.param("id"), user.id);
    if (note) {
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
    const note = await loadOwnedNote(db, c.req.param("id"), user.id);
    if (note) {
      // Publications reference the note; drop them first so their URLs die
      // with the note instead of dangling (and the FK stays satisfied).
      await db
        .delete(nodePublications)
        .where(eq(nodePublications.noteId, note.id));
      await db.delete(notes).where(eq(notes.id, note.id));
    }
    return c.redirect("/trash", 303);
  })
  .post("/notes/:id/pin", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/");
    const db = drizzle(c.env.DB);
    const note = await loadOwnedNote(db, c.req.param("id"), user.id);
    if (note) {
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
    const id = c.req.param("id");
    const db = drizzle(c.env.DB);
    const note = await db.select().from(notes).where(eq(notes.id, id)).get();
    const access = resolveEditPageAccess({ note, viewer: user });
    switch (access.kind) {
      case "not-found":
        return c.notFound();
      case "redirect-to-view":
        return c.redirect(`/notes/${id}`);
      case "redirect-to-home":
        return c.redirect("/");
      case "render": {
        const owned = access.note;
        const content =
          (await decodeStoredNoteContent(owned.content, noteStorageMode(owned.isPublic), c.env.ENCRYPTION_KEY)) ??
          "";
        return c.render("Notes/Edit", {
          user: access.viewer,
          note: { id: owned.id, title: owned.title, content, isPublic: owned.isPublic },
        });
      }
      default:
        return assertNever(access);
    }
  })
  .get("/sites/:pubId/edit", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/");
    const db = drizzle(c.env.DB);
    const pubId = c.req.param("pubId");
    const [owned, site] = await Promise.all([
      loadOwnedPublicationNode(db, pubId, user.id, c.env.ENCRYPTION_KEY),
      db.select({ template: sites.template, schema: sites.schema }).from(sites).where(eq(sites.publicationId, pubId)).get(),
    ]);
    if ("error" in owned) {
      return owned.error === "decrypt" ? c.text("Decryption failed", 500) : c.notFound();
    }
    const data = toSiteNode(owned.node);
    const schema = site?.schema ?? "";
    return c.render("Sites/Edit", {
      user,
      publicationId: pubId,
      noteId: owned.note.id,
      data,
      schema,
      template: site?.template ?? defaultTemplate(effectiveSchema(schema, data)),
      published: !!site,
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
    const access = resolveViewPageAccess({ note, viewer: user });
    if (access.kind === "not-found") return c.notFound();

    const owned = access.note;
    const content = await decodeStoredNoteContent(owned.content, noteStorageMode(owned.isPublic), c.env.ENCRYPTION_KEY);
    if (content === null) return c.text("Decryption failed", 500);
    return c.render("Notes/Show", {
      user: access.viewer,
      note: { id: owned.id, title: owned.title, content, isPublic: owned.isPublic },
    });
  });

export default routes;
