/**
 * MCP ツールが触るノートの永続化。ツールは {@link NoteStore} だけを見るので、テストは
 * メモリ上の実装を渡せる。一覧と作成は utils/noteRepository.ts のもの（/notes と同じ形、
 * 同じ保存ポリシー）。
 *
 * ゴミ箱のノートは一覧にも読み書きにも出さない（見つからない扱い）。
 *
 * 既存ノートの読み書きはエディタと同じノートごとの NoteRoom（app/sync/room.ts）を通す。
 * 編集は依頼（NoteEditRequest）ごと NoteRoom.applyEdit に渡し、NoteRoom がその時点の
 * ノートに 1 回の順番の中で当てて commit する。開いているエディタの編集と併合され、
 * version が進み、開いているエディタへも配信される。D1 を直接 UPDATE しないこと。
 */
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../global.d";
import type { MindMapDocument } from "../domain/model";
import { serializeDocument } from "../application/persistence";
import type { RoomRejection } from "../application/syncOperations";
import type { NoteEditRequest } from "../application/noteEdits";
import { insertNote, listLiveNotes } from "../utils/noteRepository";
import { noteRoom } from "../utils/noteRoom";
import { ToolInputError } from "./protocol";

export type NoteSummary = Awaited<ReturnType<typeof listLiveNotes>>[number];

/** 復号済みのノート。 */
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
  /**
   * ノートに編集を当てて、確定した文書（併合された他の編集も含む）を返す。`operationId` を
   * 渡すと、同じ依頼の再送は 1 回だけ当たる。断られたら ToolInputError。
   */
  edit(
    userId: string,
    noteId: string,
    request: NoteEditRequest,
    operationId?: string
  ): Promise<{ doc: MindMapDocument; nodeIds?: string[] }>;
}

export function d1NoteStore(env: Env["Bindings"]): NoteStore {
  const db = drizzle(env.DB);

  return {
    list: (userId) => listLiveNotes(db, userId),

    async load(userId, noteId) {
      // 所有者・ゴミ箱の確認は NoteRoom が同じ 1 行の SELECT で行う。updatedAt もその行のもの。
      // 旧テキスト形式でも NoteRoom が振った安定 id の文書が返るので、そのまま差分を取れる。
      const result = await noteRoom(env, noteId).snapshot({ noteId, userId });
      if (result.ok) return { id: noteId, updatedAt: result.value.updatedAt, doc: result.value.model };
      if (result.code === "not-found") return null;
      if (result.code === "decrypt-failed") return "decrypt-failed";
      throw new Error(`Unexpected snapshot rejection: ${result.code}`);
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

    async edit(userId, noteId, request, operationId) {
      const result = await noteRoom(env, noteId).applyEdit({ noteId, userId }, { request, operationId });
      if (!result.ok) throw new ToolInputError(rejectionForAgent(noteId, result));
      return { doc: result.value.model, nodeIds: result.value.nodeIds };
    },
  };
}

/** NoteRoom が断った理由を、エージェントが次に何をすればよいか分かる文言にする。 */
export function rejectionForAgent(noteId: string, r: RoomRejection): string {
  switch (r.code) {
    case "conflict":
      return r.detail; // 読み直してやり直す指示が付いている
    case "not-found":
      return `Note not found: ${noteId}`;
    case "decrypt-failed":
      return `Note could not be decrypted: ${noteId}`;
    case "too-large":
      return "The edit is too large (over 1 MB). Split it into smaller edits.";
    case "version-conflict":
      return `Note ${noteId} changed during the edit. Read the note again and retry.`;
    case "operation-reused":
      return "This operationId was already used for a different edit. Use a new operationId for a new edit.";
    case "invalid-commit":
      return `The edit could not be applied: ${r.detail}`;
    case "invalid-edit":
      return r.detail;
  }
}
