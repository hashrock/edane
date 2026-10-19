/**
 * MCP ツールが触るノートの永続化。ツールは {@link NoteStore} だけを見るので、テストは
 * メモリ上の実装を渡せる。D1 版の問い合わせと書き込みは utils/noteRepository.ts のもの
 * （/notes の一覧・エディタの保存と同じ形、同じ保存ポリシー）。
 *
 * ゴミ箱のノートは一覧にも読み書きにも出さない（見つからない扱い）。
 */
import { drizzle } from "drizzle-orm/d1";
import { decodeStoredNoteContent, noteStorageMode } from "../utils/crypto";
import { insertNote, listLiveNotes, updateLiveNote } from "../utils/noteRepository";
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
  /** 書き戻すときの保存ポリシー（公開 = 平文、非公開 = 暗号化）を決める。 */
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
  /** load したノートに平文の content を書き戻す（そのノートの公開状態で暗号化する）。 */
  saveContent(userId: string, note: StoredNote, content: string): Promise<void>;
  /** 見つからなければ false。 */
  rename(userId: string, noteId: string, title: string): Promise<boolean>;
}

export function d1NoteStore(d1: D1Database, encryptionKey: string): NoteStore {
  const db = drizzle(d1);
  const now = () => new Date().toISOString();

  return {
    list: (userId) => listLiveNotes(db, userId),

    async load(userId, noteId) {
      const note = await loadOwnedNote(db, noteId, userId);
      if (!note || note.deletedAt !== null) return null;
      const content = await decodeStoredNoteContent(note.content, noteStorageMode(note.isPublic), encryptionKey);
      if (content === null) return "decrypt-failed";
      return { id: note.id, title: note.title, isPublic: note.isPublic, updatedAt: note.updatedAt, content };
    },

    async create(userId, { title, content }) {
      const id = crypto.randomUUID();
      await insertNote(db, { id, userId, title, plainContent: content, isPublic: false, now: now() }, encryptionKey);
      return { id };
    },

    async saveContent(userId, note, content) {
      await updateLiveNote(
        db,
        { id: note.id, userId, content: { plain: content, isPublic: note.isPublic }, now: now() },
        encryptionKey
      );
    },

    rename: (userId, noteId, title) => updateLiveNote(db, { id: noteId, userId, title, now: now() }, encryptionKey),
  };
}
