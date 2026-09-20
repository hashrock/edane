/**
 * Write-side repository for notes / node publications / sites: the INSERT and
 * UPSERT shapes live here once, used by both the request handlers in
 * server.ts and the scenario seeder (scenarios/seed.ts). The storage policy
 * for note content (public = plaintext, private = encrypted) is applied here
 * too, so no caller can store a private note in the clear by mistake.
 */
import type { DrizzleD1Database } from "drizzle-orm/d1";
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
  schema: string;
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
