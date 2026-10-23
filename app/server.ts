import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { AGENT_INPUT_LIMITS, codePointLength } from "./application/agentInput";
import { API_TOKEN_TTL_MS } from "./utils/apiToken";
import { cors } from "hono/cors";
import { inertia } from "@hono/inertia";
import { googleAuth } from "@hono/oauth-providers/google";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { rootView } from "./root-view";
import { users, notes, apiTokens, images, nodePublications, webPages } from "./db/schema";
import { authMiddleware, selectAuth } from "./auth";
import { requireRouteUser, routePolicyMiddleware, signedInUser } from "./auth/routePolicy";
import { findUserByEmail, insertUser } from "./utils/userRepository";
import { insertNote, insertPublication, listLiveNotes } from "./utils/noteRepository";
import { hashToken } from "./utils/tokenHash";
import { decodeStoredNoteContent, noteKeys, noteStorageMode } from "./utils/crypto";
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
import { fetchLinkPreview } from "./utils/linkPreview";
import {
  IMAGE_STORAGE_LIMIT_BYTES,
  MAX_IMAGE_BYTES,
  totalImageBytes,
  sniffImageType,
  imageResponseHeaders,
} from "./domain/imageStorage";
import { scenarioRoutes } from "./scenarios";
import { statsRoutes } from "./stats";
import { mcpRoutes } from "./mcp";
import { oauthServerRoutes, oauthSessionRoutes, takeOAuthReturn } from "./oauth";
import { noteRoom } from "./utils/noteRoom";
import { insertImageWithinQuota } from "./utils/imageRepository";
import type { RoomRejection } from "./application/syncOperations";
import { notFoundHtml, wantsJsonNotFound } from "./application/notFoundPage";
import type { Env } from "./global.d";
import { securityHeaders } from "./utils/securityHeaders";
import { assetsHostGate, assetsOrigin, imageUrl, onAssetsHost } from "./utils/assetsHost";
import { renderWebPage } from "./webpage-view";
import { WEB_PAGE_CSP, type WebPagePublicationStatus } from "./application/webPagePublication";

const app = new Hono<Env>();

// Baseline headers (CSP frame-ancestors / script-src, nosniff) on every response.
app.use("*", securityHeaders);
// The assets host (utils/assetsHost.ts) serves uploaded images and nothing else.
app.use("*", assetsHostGate());
// Each route's policy (auth/routePolicy.ts), first: CSRF, browser-only, rate limit, body size.
app.use("*", routePolicyMiddleware());

// --- Signup stats for the repos.hashrock.info admin (Bearer STATS_TOKEN) ---
// Mounted before the session middleware on purpose: it must not depend on
// cookies or the AuthProvider at all. Everything lives in app/stats/.
app.route("/api/stats", statsRoutes());

// --- Remote MCP server (Bearer API token only; see docs/mcp.md) ---
// Also before the session middleware: a session cookie must never authorize
// it, or any site could post a form that edits the signed-in user's notes.
app.route("/mcp", mcpRoutes());
// OAuth for /mcp (ChatGPT / claude.ai connectors): discovery metadata, client
// registration and the token endpoint. Cookie-free like /mcp, so also here.
app.route("/", oauthServerRoutes());

// --- Session middleware ---
// Who is signed in is decided by the AuthProvider selected from env (auth/):
// the real session cookie in production, the dev bypass (Dev User /
// impersonation) only when DEV_BYPASS_AUTH is set. Nothing here branches on
// the request itself.
app.use("*", authMiddleware(selectAuth));
// Then guests are turned away from signed-in routes; handlers take the user from signedInUser.
app.use("*", requireRouteUser);

// --- Inertia middleware ---
app.use(inertia({ rootView }));

// --- OAuth consent page + connected apps (need the signed-in user) ---
app.route("/", oauthSessionRoutes());

// --- Auth (full-page redirects, not Inertia) ---
app.get(
  "/auth/google",
  googleAuth({ scope: ["openid", "email", "profile"], prompt: "select_account" }),
  async (c) => {
    const googleUser = c.get("user-google");
    if (!googleUser?.email) return c.redirect("/?error=auth");

    const db = drizzle(c.env.DB);
    const existing = await findUserByEmail(db, googleUser.email);

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
      await insertUser(db, {
        id: userId,
        email: googleUser.email,
        name: googleUser.name || "",
        avatarUrl: googleUser.picture || "",
      });
    }

    await c.get("auth").signIn(c, {
      id: userId,
      email: googleUser.email,
      name: googleUser.name || "",
      avatarUrl: googleUser.picture || "",
    });

    // Sent here from the OAuth consent page while signed out: go back to it.
    return c.redirect(takeOAuthReturn(c) ?? "/notes");
  }
);

app.post("/auth/logout", async (c) => {
  await c.get("auth").signOut(c);
  return c.redirect("/");
});

// All editor writes go through the note coordinator, including legacy PUT.
app.get("/api/notes/:id/sync", async (c) => {
  const user = signedInUser(c);
  const id = c.req.param("id");
  // NoteRoom checks owner and trash itself (404 for both, as for a missing note),
  // and, for a socket, that the credential it was opened with is still live.
  const identity = { noteId: id, userId: user.id, credential: c.get("credential") ?? undefined };
  // Upgrades from another origin are refused by the route policy (cross-site WebSocket hijacking).
  if (c.req.header("Upgrade")?.toLowerCase() === "websocket") {
    const headers = new Headers(c.req.raw.headers);
    headers.set("X-Note-Identity", JSON.stringify(identity));
    return noteRoom(c.env, id).fetch(new Request(c.req.url, { headers }));
  }
  const result = await noteRoom(c.env, id).snapshot(identity);
  return result.ok ? c.json(result.value) : roomRejectionResponse(c, result);
});
app.put("/api/notes/:id", async (c) => {
  const user = signedInUser(c);
  const id = c.req.param("id");
  const body = await c.req.json<{ title?: string; content?: string; isPublic?: boolean; version?: number }>();
  if (!Number.isSafeInteger(body.version)) return c.json({ error: "version required; GET /api/notes/:id/sync first" }, 428);
  if ((body.title !== undefined && typeof body.title !== "string") || (body.content !== undefined && typeof body.content !== "string") || (body.isPublic !== undefined && typeof body.isPublic !== "boolean")) return c.json({ error: "Invalid note" }, 400);
  const result = await noteRoom(c.env, id).replace({ noteId: id, userId: user.id }, body);
  return result.ok ? c.json(result.value) : roomRejectionResponse(c, result);
});

/** HTTP status for a NoteRoom refusal (the JSON sync routes above). */
function roomRejectionResponse(c: Context<Env>, r: RoomRejection) {
  switch (r.code) {
    case "not-found":
      return c.notFound();
    case "decrypt-failed":
      return c.json({ error: "Decryption failed" }, 500);
    case "conflict":
      return c.json({ error: r.detail }, 409);
    case "version-conflict":
      return c.json({ error: "Version conflict; reload before replacing the note" }, 409);
    case "operation-reused":
      return c.json({ error: "Operation ID reused with different content" }, 409);
    case "invalid-commit":
      return c.json({ error: r.detail }, 400);
    case "too-large":
      return c.json({ error: "Commit exceeds 1 MB" }, 413);
  }
}

// --- API tokens (JSON; used by the desktop app via Bearer auth) ---
const MAX_TOKEN_NAME = 100;
app.post("/api/tokens", async (c) => {
  const user = signedInUser(c);

  const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  if (body.name !== undefined && (typeof body.name !== "string" || codePointLength(body.name) > MAX_TOKEN_NAME)) {
    return c.json({ error: `name must be at most ${MAX_TOKEN_NAME} characters` }, 400);
  }
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
    expiresAt: Date.now() + API_TOKEN_TTL_MS,
  });

  // Return the raw token only once — it cannot be retrieved later
  return c.json({ id, token: rawToken, name: body.name || "default" }, 201);
});

app.get("/api/tokens", async (c) => {
  const user = signedInUser(c);

  const db = drizzle(c.env.DB);
  const tokens = await db
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      createdAt: apiTokens.createdAt,
      expiresAt: apiTokens.expiresAt,
    })
    .from(apiTokens)
    .where(eq(apiTokens.userId, user.id));

  return c.json(tokens);
});

app.delete("/api/tokens/:id", async (c) => {
  const user = signedInUser(c);

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
  const user = signedInUser(c);
  const db = drizzle(c.env.DB);
  const rows = await db
    .select()
    .from(images)
    .where(eq(images.userId, user.id))
    .orderBy(desc(images.createdAt));
  const used = totalImageBytes(rows.map((r) => r.size));
  const origin = assetsOrigin(c.env);
  return c.json({
    images: rows.map((r) => ({
      id: r.id,
      url: imageUrl(r.id, origin),
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
  const user = signedInUser(c);

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "No file provided" }, 400);
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return c.json({ error: "Image too large", limit: MAX_IMAGE_BYTES, fileSize: file.size }, 413);
  }
  // The stored type comes from the bytes, never from the client (see sniffImageType).
  const bytes = new Uint8Array(await file.arrayBuffer());
  // SVG only with an assets origin to serve it from (see ALLOWED_IMAGE_TYPES).
  const contentType = sniffImageType(bytes);
  const svgAllowed = assetsOrigin(c.env) !== null;
  if (!contentType || (contentType === "image/svg+xml" && !svgAllowed)) {
    const types = svgAllowed ? "PNG, JPEG, GIF, WebP, AVIF and SVG" : "PNG, JPEG, GIF, WebP and AVIF";
    return c.json({ error: `Only ${types} images are allowed` }, 400);
  }

  // Reserve the quota first (the check is inside the INSERT, so it holds under
  // parallel uploads), then store the bytes; a failed store gives the space back.
  const id = crypto.randomUUID();
  const r2Key = `${user.id}/${id}`;
  const createdAt = new Date().toISOString();
  const filename = file.name.slice(0, 200);
  const row = { id, userId: user.id, r2Key, filename, contentType, size: file.size, createdAt };
  if (!(await insertImageWithinQuota(c.env.DB, row, IMAGE_STORAGE_LIMIT_BYTES))) {
    return c.json({ error: "Storage limit exceeded", limit: IMAGE_STORAGE_LIMIT_BYTES, fileSize: file.size }, 413);
  }
  try {
    await c.env.IMAGES.put(r2Key, bytes, { httpMetadata: { contentType } });
  } catch (e) {
    await drizzle(c.env.DB).delete(images).where(eq(images.id, id));
    throw e;
  }

  return c.json(
    {
      id,
      url: imageUrl(id, assetsOrigin(c.env)),
      filename,
      contentType,
      size: file.size,
      createdAt,
    },
    201
  );
});

app.delete("/api/images/:id", async (c) => {
  const user = signedInUser(c);
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

// Serve the binary. Public (no auth) so it works inside public notes / <img>;
// imageResponseHeaders keeps a top-level visit from running script on our origin.
// With an assets host, the app host only redirects there (notes saved before the
// move hold this relative URL).
app.get("/api/images/:id/raw", async (c) => {
  const id = c.req.param("id");
  const origin = assetsOrigin(c.env);
  if (origin && !onAssetsHost(c.req.url, origin)) return c.redirect(imageUrl(id, origin), 302);
  const db = drizzle(c.env.DB);
  const meta = await db.select().from(images).where(eq(images.id, id)).get();
  if (!meta) return c.notFound();
  const obj = await c.env.IMAGES.get(meta.r2Key);
  if (!obj) return c.notFound();
  return new Response(obj.body, { headers: imageResponseHeaders(meta.contentType, origin !== null) });
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
 * decryption path. Used by /pub/:file.
 */
async function loadServablePublication(db: DrizzleD1Database, pubId: string) {
  const pub = await db
    .select()
    .from(nodePublications)
    .where(eq(nodePublications.id, pubId))
    .get();
  if (!pub) return null;
  const note = await db.select().from(notes).where(eq(notes.id, pub.noteId)).get();
  if (!note || !canServePublication(note, pub)) return null;
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
  const user = signedInUser(c);

  const db = drizzle(c.env.DB);
  const note = await loadOwnedNote(db, c.req.param("id"), user.id);
  if (!note || note.deletedAt) return c.json({ error: "Not found" }, 404);
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
    // Publishing again after the note was private / trashed is the owner's choice to resume this URL.
    if (existing.publicEpoch !== note.publicEpoch) {
      await db.update(nodePublications).set({ publicEpoch: note.publicEpoch }).where(eq(nodePublications.id, existing.id));
    }
    return c.json({
      id: existing.id,
      nodeId: existing.nodeId,
      createdAt: existing.createdAt,
    });
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await insertPublication(db, { id, userId: user.id, noteId: note.id, nodeId: body.nodeId, createdAt, publicEpoch: note.publicEpoch });
  return c.json({ id, nodeId: body.nodeId, createdAt }, 201);
});

// List the current user's publications for the settings page: note title +
// the branch's root-to-node path (階層), plus why an inactive one is inactive.
// Decoding here is owner-facing (same as the edit page), so a note that went
// back to private still shows its path — the PUBLIC serve path above never
// decrypts.
app.get("/api/publications", async (c) => {
  const user = signedInUser(c);

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
      notePublicEpoch: notes.publicEpoch,
      publicEpoch: nodePublications.publicEpoch,
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
      const content = await decodeStoredNoteContent(r.noteContent, noteStorageMode(r.noteIsPublic), noteKeys(c.env), r.noteId);
      model = content === null ? null : parseContent(content, r.noteTitle);
      models.set(r.noteId, model);
    }
    const path = model ? nodePathTexts(model, r.nodeId) : null;
    const servable = canServePublication(
      { isPublic: r.noteIsPublic, deletedAt: r.noteDeletedAt, publicEpoch: r.notePublicEpoch },
      r
    );
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
        : !r.noteIsPublic || r.notePublicEpoch !== r.publicEpoch
          ? "note-private"
          : path === null
            ? "node-missing"
            : null,
    });
  }
  return c.json({ publications });
});

app.delete("/api/publications/:id", async (c) => {
  const user = signedInUser(c);

  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  if (!(await loadOwnedPublication(db, id, user.id))) {
    return c.json({ error: "Not found" }, 404);
  }
  await db.delete(nodePublications).where(eq(nodePublications.id, id));
  return c.json({ ok: true });
});

// --- Web pages: a whole note as themed pages (Webページモード) ---
// Rendered from the LIVE note on every request (see
// application/webPagePublication.ts): only public notes serve, and only while
// the publication's epoch matches the note's.

app.get("/w/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const page = await db.select().from(webPages).where(eq(webPages.id, c.req.param("id"))).get();
  if (!page) return c.notFound();
  const note = await db.select().from(notes).where(eq(notes.id, page.noteId)).get();
  if (!note || !canServePublication(note, page)) return c.notFound();
  return c.html(renderWebPage(parseContent(note.content, note.title)), 200, {
    "Content-Security-Policy": WEB_PAGE_CSP,
    "Cache-Control": "no-cache",
  });
});

/** The owned, live note and its web page row (if published), or null (= not found). */
async function loadOwnedWebPage(db: DrizzleD1Database, noteId: string, userId: string) {
  const note = await loadOwnedNote(db, noteId, userId);
  if (!note || note.deletedAt) return null;
  const page = await db.select().from(webPages).where(eq(webPages.noteId, note.id)).get();
  return { note, page: page ?? null };
}

const webPageStatus = (
  note: { isPublic: boolean; deletedAt: string | null; publicEpoch: number },
  page: { id: string; publicEpoch: number } | null
): { publication: WebPagePublicationStatus | null } => ({
  publication: page ? { id: page.id, active: canServePublication(note, page) } : null,
});

app.get("/api/notes/:id/webpage", async (c) => {
  const owned = await loadOwnedWebPage(drizzle(c.env.DB), c.req.param("id"), signedInUser(c).id);
  if (!owned) return c.json({ error: "Not found" }, 404);
  return c.json(webPageStatus(owned.note, owned.page));
});

// Publish (or resume, after the note was private / trashed) — idempotent per note.
app.post("/api/notes/:id/webpage", async (c) => {
  const user = signedInUser(c);
  const db = drizzle(c.env.DB);
  const owned = await loadOwnedWebPage(db, c.req.param("id"), user.id);
  if (!owned) return c.json({ error: "Not found" }, 404);
  const { note, page } = owned;
  if (!note.isPublic) return c.json({ error: PRIVATE_NOTE_PUBLISH_REASON }, 400);
  if (page) {
    if (page.publicEpoch !== note.publicEpoch) {
      await db.update(webPages).set({ publicEpoch: note.publicEpoch }).where(eq(webPages.id, page.id));
    }
    return c.json(webPageStatus(note, { ...page, publicEpoch: note.publicEpoch }));
  }
  const created = { id: crypto.randomUUID(), userId: user.id, noteId: note.id, publicEpoch: note.publicEpoch, createdAt: new Date().toISOString() };
  // The unique index on note_id settles a double click: the loser reads the winner's row.
  await db.insert(webPages).values(created).onConflictDoNothing();
  const row = await db.select().from(webPages).where(eq(webPages.noteId, note.id)).get();
  return c.json(webPageStatus(note, row ?? null), row?.id === created.id ? 201 : 200);
});

app.delete("/api/notes/:id/webpage", async (c) => {
  const db = drizzle(c.env.DB);
  const owned = await loadOwnedWebPage(db, c.req.param("id"), signedInUser(c).id);
  if (!owned) return c.json({ error: "Not found" }, 404);
  await db.delete(webPages).where(eq(webPages.noteId, owned.note.id));
  return c.json(webPageStatus(owned.note, null));
});

// --- UI test scenarios: seed an isolated initial state and redirect to it ---
// Public-safe (insert-only, current user's own data, no auth bypass, refused when
// navigated to from another site); see
// docs/ui-test-scenarios.md. Everything lives in app/scenarios/.
app.route("/__scenarios", scenarioRoutes());

// --- Unhandled errors: details go to the log, never to the client ---
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error(err);
  return c.json({ error: "Internal error" }, 500);
});

// --- 404: a real page with a way back, not Hono's bare text (usertest #13) ---
// Every `c.notFound()` in the routes above lands here.
app.notFound((c) => {
  const path = new URL(c.req.url).pathname;
  // NotFoundHandler is typed as a text response; both bodies below are real
  // Responses with status 404, the cast only satisfies that nominal type.
  const res = wantsJsonNotFound(path, c.req.header("accept"))
    ? c.json({ error: "Not found" }, 404)
    : c.html(notFoundHtml(), 404);
  return res as unknown as ReturnType<typeof c.notFound>;
});

// --- Link preview: server-side fetch of <title> + favicon (avoids CORS) ---
// Open to guests (the landing page editor uses it), so it is rate-limited per
// IP (the route policy) and each fetch is bounded (utils/linkPreview.ts): not a free proxy.
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
  const preview = await fetchLinkPreview(target).catch(() => null);
  return preview ? c.json(preview) : c.json({ error: "fetch failed" }, 502);
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
    const user = signedInUser(c);
    // Trashed notes live on the /trash page.
    const myNotes = await listLiveNotes(drizzle(c.env.DB), user.id);
    return c.render("Notes/Index", { user, notes: myNotes });
  })
  .get("/trash", async (c) => {
    const user = signedInUser(c);
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
    const user = signedInUser(c);
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
  .post("/notes", async (c) => {
    const user = signedInUser(c);

    const body = await c.req
      .json<{ title?: string; content?: string }>()
      .catch(() => ({}) as { title?: string; content?: string });
    if (
      (body.title !== undefined && (typeof body.title !== "string" || codePointLength(body.title) > AGENT_INPUT_LIMITS.title)) ||
      (body.content !== undefined && typeof body.content !== "string")
    ) {
      return c.json({ error: "Invalid note" }, 400);
    }
    const id = crypto.randomUUID();
    // Guest-mode imports arrive with their own serialized content; a plain
    // "new note" falls back to the starter topics. There is no new-note form
    // anymore, so a note is always born private and is flipped from the
    // editor header.
    await insertNote(
      drizzle(c.env.DB),
      {
        id,
        userId: user.id,
        title: body.title || "Untitled",
        plainContent: body.content ?? "トピック1\nトピック2",
        isPublic: false,
        now: new Date().toISOString(),
      },
      noteKeys(c.env)
    );

    return c.redirect(`/notes/${id}/edit`, 303);
  })
  .post("/notes/:id/trash", async (c) => {
    // Soft delete: move to the trash (restorable). The main list hides it.
    const user = signedInUser(c);
    const db = drizzle(c.env.DB);
    const note = await loadOwnedNote(db, c.req.param("id"), user.id);
    if (note) {
      await db
        .update(notes)
        .set({ deletedAt: new Date().toISOString() })
        .where(eq(notes.id, note.id));
      await noteRoom(c.env, note.id).invalidate();
    }
    return c.redirect("/notes", 303);
  })
  .post("/notes/:id/restore", async (c) => {
    // Bring a trashed note back to the main list.
    const user = signedInUser(c);
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
    const user = signedInUser(c);
    const db = drizzle(c.env.DB);
    const note = await loadOwnedNote(db, c.req.param("id"), user.id);
    if (note) {
      // Publications reference the note; drop them first so their URLs die
      // with the note instead of dangling (and the FK stays satisfied).
      await db
        .delete(nodePublications)
        .where(eq(nodePublications.noteId, note.id));
      await db.delete(webPages).where(eq(webPages.noteId, note.id));
      await db.delete(notes).where(eq(notes.id, note.id));
      await noteRoom(c.env, note.id).invalidate();
    }
    return c.redirect("/trash", 303);
  })
  .post("/notes/:id/pin", async (c) => {
    const user = signedInUser(c);
    const db = drizzle(c.env.DB);
    const note = await loadOwnedNote(db, c.req.param("id"), user.id);
    if (note && !note.deletedAt) {
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
          (await decodeStoredNoteContent(owned.content, noteStorageMode(owned.isPublic), noteKeys(c.env), owned.id)) ??
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
    const content = await decodeStoredNoteContent(owned.content, noteStorageMode(owned.isPublic), noteKeys(c.env), owned.id);
    if (content === null) return c.text("Decryption failed", 500);
    return c.render("Notes/Show", {
      user: access.viewer,
      note: { id: owned.id, title: owned.title, content, isPublic: owned.isPublic },
    });
  });

export default routes;

export { NoteRoom } from "./sync/room";
