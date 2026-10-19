/**
 * Write-side repository for notes / node publications / sites: the INSERT and
 * UPSERT shapes live here once, used by both the request handlers in
 * server.ts and the scenario seeder (scenarios/seed.ts). The storage policy
 * for note content (public = plaintext, private = encrypted) is applied here
 * too, so no caller can store a private note in the clear by mistake.
 */
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { and, desc, eq, isNull } from "drizzle-orm";
import { notes, nodePublications, sites } from "../db/schema";
import { encodeNoteContentForStorage, noteStorageMode } from "./crypto";

export interface NewNote {
  id: string;
  userId: string;
  title: string;
  /** Plaintext (serialized model or legacy text); encoded per `isPublic`. */
  plainContent: string;
  isPublic: boolean;
  pinned?: boolean;
  /** Soft-delete timestamp — set to create the note already in the trash. */
  deletedAt?: string | null;
  now: string;
}

export async function insertNote(db: DrizzleD1Database, note: NewNote, encryptionKey: string): Promise<void> {
  const content = await encodeNoteContentForStorage(
    note.plainContent,
    noteStorageMode(note.isPublic),
    encryptionKey
  );
  await db.insert(notes).values({
    id: note.id,
    userId: note.userId,
    title: note.title,
    content,
    isPublic: note.isPublic,
    pinned: note.pinned ?? false,
    deletedAt: note.deletedAt ?? null,
    createdAt: note.now,
    updatedAt: note.now,
  });
}

/** The user's notes outside the trash: pinned first, then most recently updated. */
export async function listLiveNotes(db: DrizzleD1Database, userId: string) {
  return db
    .select({
      id: notes.id,
      title: notes.title,
      isPublic: notes.isPublic,
      pinned: notes.pinned,
      updatedAt: notes.updatedAt,
    })
    .from(notes)
    .where(and(eq(notes.userId, userId), isNull(notes.deletedAt)))
    .orderBy(desc(notes.pinned), desc(notes.updatedAt));
}

export interface LiveNoteUpdate {
  id: string;
  userId: string;
  title?: string;
  /** Plaintext; encoded per `isPublic` (the note's current publicity). */
  content?: { plain: string; isPublic: boolean };
  now: string;
}

/**
 * Update a note the user owns and that is not in the trash, in one statement
 * (ownership and liveness are part of the WHERE). Returns whether it matched.
 */
export async function updateLiveNote(
  db: DrizzleD1Database,
  update: LiveNoteUpdate,
  encryptionKey: string
): Promise<boolean> {
  const content =
    update.content &&
    (await encodeNoteContentForStorage(update.content.plain, noteStorageMode(update.content.isPublic), encryptionKey));
  const rows = await db
    .update(notes)
    .set({
      ...(update.title !== undefined && { title: update.title }),
      ...(content !== undefined && { content }),
      updatedAt: update.now,
    })
    .where(and(eq(notes.id, update.id), eq(notes.userId, update.userId), isNull(notes.deletedAt)))
    .returning({ id: notes.id });
  return rows.length > 0;
}

export interface NewPublication {
  id: string;
  userId: string;
  noteId: string;
  nodeId: string;
  createdAt: string;
}

export async function insertPublication(db: DrizzleD1Database, pub: NewPublication): Promise<void> {
  await db.insert(nodePublications).values(pub);
}

export interface SiteUpsert {
  publicationId: string;
  userId: string;
  template: string;
  html: string;
  css: string;
  updatedAt: string;
}

/** Insert or replace the site for a publication (one site per publication). */
export async function upsertSite(db: DrizzleD1Database, site: SiteUpsert): Promise<void> {
  const { publicationId, userId, ...row } = site;
  await db
    .insert(sites)
    .values({ publicationId, userId, ...row })
    .onConflictDoUpdate({ target: sites.publicationId, set: row });
}
