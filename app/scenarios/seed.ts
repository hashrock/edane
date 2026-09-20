/**
 * 計画（ScenarioPlan）を D1 に書き込む。INSERT / UPSERT しかしない——既存行の更新・
 * 削除はここには存在しないので、本番で叩かれても他のデータに影響しない。
 *
 * 書き込みの形は utils/noteRepository.ts のもので、server.ts の各ハンドラと同じ
 * （暗号化の方針も含めてそこに一本化してある）。FK の順（notes →
 * node_publications → sites）で入れる。
 */
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { insertNote, insertPublication, upsertSite } from "../utils/noteRepository";
import { serializeDocument } from "../application/persistence";
import type { ScenarioPlan } from "./plan";

export async function applyScenarioPlan(
  db: DrizzleD1Database,
  plan: ScenarioPlan,
  userId: string,
  encryptionKey: string,
  now: string = new Date().toISOString()
): Promise<void> {
  for (const n of plan.notes) {
    await insertNote(
      db,
      {
        id: n.id,
        userId,
        title: n.title,
        plainContent: serializeDocument(n.model),
        isPublic: n.isPublic,
        pinned: n.pinned,
        deletedAt: n.trashed ? now : null,
        now,
      },
      encryptionKey
    );
  }
  for (const p of plan.publications) {
    await insertPublication(db, { id: p.id, userId, noteId: p.noteId, nodeId: p.nodeId, createdAt: now });
  }
  for (const s of plan.sites) {
    await upsertSite(db, { ...s, userId, updatedAt: now });
  }
}
