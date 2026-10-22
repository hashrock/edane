/**
 * MCP ツールが触るノートの永続化。ツールは {@link NoteStore} だけを見るので、テストは
 * メモリ上の実装を渡せる。一覧と作成は utils/noteRepository.ts のもの（/notes と同じ形、
 * 同じ保存ポリシー）。
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
import { serializeDocument } from "../application/persistence";
import { diffDocument, hasChanges } from "../application/syncOperations";
import { insertNote, listLiveNotes } from "../utils/noteRepository";
import { loadOwnedNote } from "../utils/noteOwnership";
import { noteRoom } from "../utils/noteRoom";
import { ToolInputError } from "./protocol";

export type NoteSummary = Awaited<ReturnType<typeof listLiveNotes>>[number];

/** 復号済みのノート。`doc` は読んだ時点の文書で、保存はこれとの差分になる。 */
export interface StoredNote {
  id: string;
  updatedAt: string;
  doc: MindMapDocument;
}

export interface NoteStore {
  /** ピン留めが先、あとは更新が新しい順（/notes の一覧と同じ）。 */
  list(userId: string): Promise<NoteSummary[]>;
  /** 自分のノートで、ゴミ箱に無いものだけ。復号に失敗したら "decrypt-failed"。 */
  load(userId: string, noteId: string): Promise<StoredNote | null | "decrypt-failed">;
  create(userId: string, doc: MindMapDocument): Promise<{ id: string }>;
  /** load したノートを `after` にする。読んだ後の他の編集とは差分の単位で併合される。 */
  save(userId: string, note: StoredNote, after: MindMapDocument): Promise<void>;
}

export function d1NoteStore(env: Env["Bindings"]): NoteStore {
  const db = drizzle(env.DB);

  return {
    list: (userId) => listLiveNotes(db, userId),

    async load(userId, noteId) {
      const note = await loadOwnedNote(db, noteId, userId);
      if (!note || note.deletedAt !== null) return null;
      try {
        // 旧テキスト形式でも NoteRoom が振った安定 id の文書が返るので、そのまま差分を取れる。
        const { model } = await noteRoom(env, noteId).snapshot({ noteId, userId });
        return { id: note.id, updatedAt: note.updatedAt, doc: model };
      } catch (e) {
        if ((e as Error).message === "Decryption failed") return "decrypt-failed";
        throw e;
      }
    },

    async create(userId, doc) {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      await insertNote(
        db,
        { id, userId, title: doc.title, plainContent: serializeDocument(doc), isPublic: false, now },
        env.ENCRYPTION_KEY
      );
      return { id };
    },

    async save(userId, note, after) {
      const patch = diffDocument(note.doc, after);
      if (!hasChanges(patch)) return;
      try {
        await noteRoom(env, note.id).commit({ noteId: note.id, userId }, { id: crypto.randomUUID(), patch });
      } catch (e) {
        const rejection = commitRejection(note.id, (e as Error).message);
        if (rejection === null) throw e;
        throw new ToolInputError(rejection);
      }
    },
  };
}

/**
 * NoteRoom が commit を断った理由のうち、エージェントに返してよいもの（読み直せば
 * 済む・入力を小さくすれば済む）を、エージェント向けの文言にする。それ以外（D1 の障害
 * など）は null — 内部エラーのまま返し、中身を見せない。RPC 越しに例外の型は残らない
 * ので文言で判別する（文言は app/sync/room.ts と application/syncOperations.ts のもの）。
 */
export function commitRejection(noteId: string, message: string): string | null {
  if (message.startsWith("Concurrent change: ")) return message; // 読み直しの指示が付いている
  if (message.startsWith("Note changed or was deleted")) {
    return `Note ${noteId} changed or was deleted during the edit. Read the note again and retry.`;
  }
  if (message === "Note unavailable") return `Note not found: ${noteId}`;
  if (message === "Commit exceeds 1 MB") return "The edit is too large (over 1 MB). Split it into smaller edits.";
  return null;
}
