/**
 * MCP ツールが触るノートの永続化。ツールは {@link NoteStore} だけを見るので、テストは
 * メモリ上の実装を渡せる。D1 版の問い合わせと書き込みは utils/noteRepository.ts のもの
 * （/notes の一覧・エディタの保存と同じ形、同じ保存ポリシー）。
 *
 * ゴミ箱のノートは一覧にも読み書きにも出さない（見つからない扱い）。
 *
 * 既存ノートの読み書きはエディタと同じノートごとの NoteRoom（app/sync/room.ts）を通す。
 * 読んだ時点からの差分だけを commit するので、開いているエディタの編集と併合され、
 * version が進み、開いているエディタへも配信される。D1 を直接 UPDATE しないこと。
 */
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../global.d";
import type { MindMapDocument } from "../domain/model";
import { parseContent, serializeDocument } from "../application/persistence";
import { diffDocument, hasChanges } from "../application/syncOperations";
import { insertNote, listLiveNotes } from "../utils/noteRepository";
import { loadOwnedNote } from "../utils/noteOwnership";
import { ToolInputError } from "./protocol";

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

export function d1NoteStore(env: Env["Bindings"]): NoteStore {
  const db = drizzle(env.DB);
  const now = () => new Date().toISOString();
  const room = (noteId: string) => env.NOTE_ROOMS.get(env.NOTE_ROOMS.idFromName(noteId));

  /** 読んだ時点の文書から編集後への差分を commit する。併合できない競合は呼び方の誤りとして返す。 */
  async function commit(userId: string, noteId: string, before: MindMapDocument, after: MindMapDocument) {
    const patch = diffDocument(before, after);
    if (!hasChanges(patch)) return;
    // patch.nodes は null プロトタイプで RPC の構造化クローンを通らない。WebSocket の
    // クライアントと同じく JSON の形で渡す（NoteRoom 側は parseCommit で検証する）。
    const input: unknown = JSON.parse(JSON.stringify({ id: crypto.randomUUID(), patch }));
    try {
      await room(noteId).commit({ noteId, userId }, input);
    } catch (e) {
      throw new ToolInputError(`${(e as Error).message}. Read the note again and retry.`);
    }
  }

  return {
    list: (userId) => listLiveNotes(db, userId),

    async load(userId, noteId) {
      const note = await loadOwnedNote(db, noteId, userId);
      if (!note || note.deletedAt !== null) return null;
      let snapshot;
      try {
        snapshot = await room(noteId).snapshot({ noteId, userId });
      } catch (e) {
        if ((e as Error).message === "Decryption failed") return "decrypt-failed";
        throw e;
      }
      // v2 に直して返す。旧テキスト形式でも NoteRoom が振った安定 id のまま差分を取れる。
      return {
        id: note.id,
        title: snapshot.model.title,
        isPublic: snapshot.isPublic,
        updatedAt: note.updatedAt,
        content: serializeDocument(snapshot.model),
      };
    },

    async create(userId, { title, content }) {
      const id = crypto.randomUUID();
      await insertNote(db, { id, userId, title, plainContent: content, isPublic: false, now: now() }, env.ENCRYPTION_KEY);
      return { id };
    },

    saveContent: (userId, note, content) =>
      commit(userId, note.id, parseContent(note.content, note.title), parseContent(content, note.title)),

    async rename(userId, noteId, title) {
      const note = await this.load(userId, noteId);
      if (note === null) return false;
      if (note === "decrypt-failed") throw new ToolInputError(`Note could not be decrypted: ${noteId}`);
      const before = parseContent(note.content, note.title);
      await commit(userId, noteId, before, { ...before, title });
      return true;
    },
  };
}
