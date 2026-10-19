/**
 * MCP ツールが触るノートの永続化。ツールは {@link NoteStore} だけを見るので、テストは
 * メモリ上の実装を渡せる。D1 版は保存ポリシー（公開 = 平文、非公開 = 暗号化）を
 * crypto.ts の encode / decode に任せ、エディタの保存と同じ形で書く。
 *
 * ゴミ箱のノートは一覧にも読み書きにも出さない（見つからない扱い）。
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, desc, eq, isNull } from "drizzle-orm";
import { notes } from "../db/schema";
import { decodeStoredNoteContent, encodeNoteContentForStorage, noteStorageMode } from "../utils/crypto";
import { insertNote } from "../utils/noteRepository";
import { loadOwnedNote } from "../utils/noteOwnership";

export interface NoteSummary {
  id: string;
  title: string;
  isPublic: boolean;
  pinned: boolean;
  updatedAt: string;
}

/** 復号済みのノート。`content` は保存形式そのまま（parseContent に渡す）。 */
export interface StoredNote {
  id: string;
  title: string;
  isPublic: boolean;
  updatedAt: string;
  content: string;
}

export interface NoteStore {
  /** ピン留めが先、あとは更新が新しい順（/notes の一覧と同じ）。 */
  list(userId: string): Promise<NoteSummary[]>;
  /** 自分のノートで、ゴミ箱に無いものだけ。復号に失敗したら "decrypt-failed"。 */
  load(userId: string, noteId: string): Promise<StoredNote | null | "decrypt-failed">;
  create(userId: string, note: { title: string; content: string }): Promise<{ id: string }>;
  /** load で確かめた後に呼ぶ。content は平文で渡し、ノートの公開状態で暗号化する。 */
  save(userId: string, noteId: string, patch: { title?: string; content?: string }): Promise<void>;
}

export function d1NoteStore(d1: D1Database, encryptionKey: string, now: () => Date = () => new Date()): NoteStore {
  const db: DrizzleD1Database = drizzle(d1);
  const loadLive = async (userId: string, noteId: string) => {
    const note = await loadOwnedNote(db, noteId, userId);
    return note && note.deletedAt === null ? note : null;
  };

  return {
    async list(userId) {
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
    },

    async load(userId, noteId) {
      const note = await loadLive(userId, noteId);
      if (!note) return null;
      const content = await decodeStoredNoteContent(note.content, noteStorageMode(note.isPublic), encryptionKey);
      if (content === null) return "decrypt-failed";
      return { id: note.id, title: note.title, isPublic: note.isPublic, updatedAt: note.updatedAt, content };
    },

    async create(userId, { title, content }) {
      const id = crypto.randomUUID();
      await insertNote(
        db,
        { id, userId, title, plainContent: content, isPublic: false, now: now().toISOString() },
        encryptionKey
      );
      return { id };
    },

    async save(userId, noteId, patch) {
      const note = await loadLive(userId, noteId);
      if (!note) return;
      const content =
        patch.content === undefined
          ? undefined
          : await encodeNoteContentForStorage(patch.content, noteStorageMode(note.isPublic), encryptionKey);
      await db
        .update(notes)
        .set({
          ...(patch.title !== undefined && { title: patch.title }),
          ...(content !== undefined && { content }),
          updatedAt: now().toISOString(),
        })
        .where(eq(notes.id, note.id));
    },
  };
}
