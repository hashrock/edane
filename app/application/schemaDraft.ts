/**
 * Application layer: スキーマ編集 UI（SchemaDialog のフィールド行リスト）の
 * 下書きモデル。行の追加・削除・並べ替えと行ごとの検証を純粋関数で持ち、
 * コンポーネントはこれを呼ぶだけにする。保存形式はあくまでスキーマの
 * 文字列（domain/branchSchema.ts）で、下書きとは {@link toDraft} /
 * {@link fromDraft} で行き来する。
 */
import {
  FIELD_TYPES,
  keyError,
  type BranchSchema,
  type FieldType,
  type SchemaField,
} from "../domain/branchSchema";

export const DRAFT_KINDS: FieldType[] = FIELD_TYPES;

export interface DraftField {
  /** React の key と編集対象の特定に使う、下書き内で一意な行 id。 */
  rid: string;
  key: string;
  kind: FieldType;
}

export type RidSource = () => string;

export function ridSource(prefix = "f"): RidSource {
  let i = 0;
  return () => `${prefix}${i++}`;
}

export function toDraft(schema: BranchSchema, rid: RidSource): DraftField[] {
  return schema.map((f) => ({ rid: rid(), key: f.key, kind: f.type ?? "text" }));
}

export function fromDraft(draft: DraftField[]): BranchSchema {
  return draft.map((d): SchemaField => ({ key: d.key, type: d.kind === "text" ? undefined : d.kind }));
}

/** 行 id → その行のキーの問題（空・不正・予約・重複）。 */
export function draftErrors(draft: DraftField[]): Map<string, string> {
  const errors = new Map<string, string>();
  const seen = new Set<string>();
  for (const row of draft) {
    const bad = keyError(row.key) ?? (seen.has(row.key) ? `キーが重複: "${row.key}"` : null);
    if (bad) errors.set(row.rid, bad);
    seen.add(row.key);
  }
  return errors;
}

export function updateField(
  draft: DraftField[],
  rid: string,
  patch: Partial<Pick<DraftField, "key" | "kind">>
): DraftField[] {
  return draft.map((r) => (r.rid === rid ? { ...r, ...patch } : r));
}

export function removeField(draft: DraftField[], rid: string): DraftField[] {
  return draft.filter((r) => r.rid !== rid);
}

/** 1 つ上 (-1) / 下 (+1) へ。端なら何もしない。 */
export function moveField(draft: DraftField[], rid: string, dir: -1 | 1): DraftField[] {
  const i = draft.findIndex((r) => r.rid === rid);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= draft.length) return draft;
  const next = [...draft];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

export function blankField(rid: RidSource): DraftField {
  return { rid: rid(), key: "", kind: "text" };
}

export function addField(draft: DraftField[], row: DraftField): DraftField[] {
  return [...draft, row];
}
