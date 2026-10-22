import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const apiTokens = sqliteTable("api_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull().default("default"),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const notes = sqliteTable("notes", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id),
  title: text("title").notNull().default("Untitled"),
  content: text("content").notNull().default(""),
  version: integer("version").notNull().default(0),
  isPublic: integer("is_public", { mode: "boolean" }).notNull().default(false),
  /** Pinned notes sort to the top of the list. */
  pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
  /** Soft-delete timestamp (ISO). Non-null = in trash, hidden from the list. */
  deletedAt: text("deleted_at"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// Uploaded image metadata. The binary lives in R2 (binding IMAGES); this row
// tracks ownership, size (for the per-user quota) and the R2 object key.
export const images = sqliteTable("images", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  r2Key: text("r2_key").notNull(),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// Node-level web publication: a random, revocable public id (the URL slug)
// pointing at one node inside a note. The served content is always the LIVE
// subtree — nothing is copied here — so deleting the node (or making the note
// private / trashing it) turns the URL into a 404. Revoking deletes the row;
// re-publishing issues a fresh id, so a leaked URL can be rotated.
export const nodePublications = sqliteTable("node_publications", {
  /** Public slug served at /pub/:id.json / /pub/:id.md (random UUID). */
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  noteId: text("note_id")
    .notNull()
    .references(() => notes.id),
  /** The published node's id inside the note's JSON tree. */
  nodeId: text("node_id").notNull(),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// A "site": one JSX template + its last build (static HTML/CSS) for a node
// publication, served at /sites/:publicationId. The build is a SNAPSHOT —
// JSX can only be compiled in the author's browser (Workers forbid eval and
// TypeScript is far too heavy), so re-publishing is how the page refreshes.
// Keyed by the publication so revoking it (row delete) orphans the site; the
// serve path re-checks the publication + note anyway.
export const sites = sqliteTable("sites", {
  /** = node_publications.id (one site per publication). */
  publicationId: text("publication_id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  template: text("template").notNull(),
  html: text("html").notNull(),
  css: text("css").notNull(),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// OAuth 2.1 for the remote MCP endpoint (docs/adr/0005-mcp-oauth.md). Rows are
// created by dynamic client registration (open — anyone may register, a client
// only gets access once a signed-in user approves it on the consent page).
export const oauthClients = sqliteTable("oauth_clients", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** JSON array of the registered redirect URIs. */
  redirectUris: text("redirect_uris").notNull(),
  /** SHA-256 of the client secret; null = public client (PKCE only). */
  secretHash: text("secret_hash"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  /**
   * Epoch ms of the first approved grant. Null = never authorized: such a
   * client is purged after a day (registration is open), an authorized one is kept.
   */
  authorizedAt: integer("authorized_at"),
});

/** Authorization codes: single use (deleted on exchange), short-lived. */
export const oauthCodes = sqliteTable("oauth_codes", {
  codeHash: text("code_hash").primaryKey(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClients.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  redirectUri: text("redirect_uri").notNull(),
  /** PKCE S256 challenge. */
  codeChallenge: text("code_challenge").notNull(),
  scope: text("scope").notNull(),
  /** Epoch ms. */
  expiresAt: integer("expires_at").notNull(),
});

/**
 * One approved client's access to one user's notes. Holds the current
 * access/refresh token pair (hashes); a refresh rotates both in place, and
 * deleting the row (Settings → connected apps) revokes the client.
 */
export const oauthGrants = sqliteTable("oauth_grants", {
  id: text("id").primaryKey(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClients.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  scope: text("scope").notNull(),
  accessTokenHash: text("access_token_hash").notNull().unique(),
  /** Epoch ms. */
  accessExpiresAt: integer("access_expires_at").notNull(),
  refreshTokenHash: text("refresh_token_hash").notNull().unique(),
  /** Epoch ms. */
  refreshExpiresAt: integer("refresh_expires_at").notNull(),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});
