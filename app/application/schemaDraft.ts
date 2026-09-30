/**
 * Application layer: スキーマ編集 UI（SchemaDialog のフィールド行リスト）の
 * 下書きモデル。行の追加・削除・並べ替え・入れ子と、行ごとの検証を純粋関数で
 * 持ち、コンポーネントはこれを呼ぶだけにする。保存形式はあくまでスキーマの
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

/** 型セレクトの選択肢。`records` は入れ子のコレクション（`key[]{…}`）。 */
export type DraftKind = FieldType | "records";
export const DRAFT_KINDS: DraftKind[] = [...FIELD_TYPES, "records"];

export interface DraftField {
  /** React の key と編集対象の特定に使う、下書き内で一意な行 id。 */
  rid: string;
  key: string;
  kind: DraftKind;
  /** `key[]`。`records` では常に true。 */
  list: boolean;
  /** `records` の子フィールド。それ以外では空。 */
  fields: DraftField[];
}

export type RidSource = () => string;

export function ridSource(prefix = "f"): RidSource {
  let i = 0;
  return () => `${prefix}${i++}`;
}

export function toDraft(schema: BranchSchema, rid: RidSource): DraftField[] {
  return schema.map((f) => ({
    rid: rid(),
    key: f.key,
    kind: f.fields ? "records" : (f.type ?? "text"),
    list: f.list,
    fields: f.fields ? toDraft(f.fields, rid) : [],
  }));
}

export function fromDraft(draft: DraftField[]): BranchSchema {
  return draft.map((d): SchemaField =>
    d.kind === "records"
      ? { key: d.key, type: undefined, list: true, fields: fromDraft(d.fields) }
      : { key: d.key, type: d.kind === "text" ? undefined : d.kind, list: d.list }
  );
}

/** 行 id → その行のキーの問題（空・不正・予約・同じ階層での重複）。 */
export function draftErrors(draft: DraftField[]): Map<string, string> {
  const errors = new Map<string, string>();
  const walk = (rows: DraftField[]) => {
    const seen = new Set<string>();
    for (const row of rows) {
      const bad = keyError(row.key) ?? (seen.has(row.key) ? `キーが重複: "${row.key}"` : null);
      if (bad) errors.set(row.rid, bad);
      seen.add(row.key);
      if (row.kind === "records") walk(row.fields);
    }
  };
  walk(draft);
  return errors;
}

/** 行 `rid` のある階層の配列に `edit` を当てた新しい下書き（見つからなければそのまま）。 */
function editLevel(
  draft: DraftField[],
  rid: string,
  edit: (rows: DraftField[], index: number) => DraftField[]
): DraftField[] {
  const i = draft.findIndex((r) => r.rid === rid);
  if (i >= 0) return edit(draft, i);
  return draft.map((r) => (r.fields.length ? { ...r, fields: editLevel(r.fields, rid, edit) } : r));
}

export function updateField(
  draft: DraftField[],
  rid: string,
  patch: Partial<Pick<DraftField, "key" | "kind" | "list">>
): DraftField[] {
  return editLevel(draft, rid, (rows, i) => {
    const next = { ...rows[i], ...patch };
    // records は並び固定。records から外したら子フィールドは捨てる。
    if (next.kind === "records") next.list = true;
    else if (rows[i].kind === "records") next.fields = [];
    return rows.map((r, j) => (j === i ? next : r));
  });
}

export function removeField(draft: DraftField[], rid: string): DraftField[] {
  return editLevel(draft, rid, (rows, i) => rows.filter((_, j) => j !== i));
}

/** 同じ階層の中で 1 つ上 (-1) / 下 (+1) へ。端なら何もしない。 */
export function moveField(draft: DraftField[], rid: string, dir: -1 | 1): DraftField[] {
  return editLevel(draft, rid, (rows, i) => {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return rows;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });
}

export function blankField(rid: RidSource): DraftField {
  return { rid: rid(), key: "", kind: "text", list: false, fields: [] };
}

/** 末尾（`parentRid` があればその records 行の子の末尾）に空の行を足す。 */
export function addField(draft: DraftField[], parentRid: string | null, row: DraftField): DraftField[] {
  if (parentRid === null) return [...draft, row];
  return editLevel(draft, parentRid, (rows, i) =>
    rows.map((r, j) => (j === i ? { ...r, fields: [...r.fields, row] } : r))
  );
}
