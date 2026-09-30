/**
 * Domain layer: 枝のスキーマ。
 *
 * スキーマはノード（コレクション）の属性 `MindMapModel.schema` に文字列で持つ。
 * コレクションの子 = レコード、レコードの子の index i = フィールド i という
 * 位置対応の読み方に、フィールドの**名前と型**を付けるだけの仕組み。
 *
 *   area, url:link, cover:image, done:check, price:number, tags[], chapters[]{name, page:number}
 *
 * - `key` は ASCII 識別子。`id` / `title` は予約（`title` はレコードノード自身の text）
 * - `:type` は注釈。ノードの形は強制せず、食い違いは {@link fieldIssue} で報告する
 *   - `text` / `image` / `link` / `markdown` … ノード種別（`NodeType`）
 *   - `check` … タスクのチェック（`checked`）を真偽値として読む
 *   - `number` / `date` … text ノードの中身の形（数値 / `YYYY-MM-DD`）
 * - `key[]` はそのフィールドノードの子を並びとして読む。`key[]:type` は各要素の型
 * - `key[]{…}` は入れ子のコレクション: フィールドノードの子がそれぞれレコードで、
 *   `{…}` がそのフィールド（外側に書くので全レコードで共通）
 *
 * エディタは新しく入ってきたレコードに足りないフィールドを型付きで補い
 * （{@link conformEntering}）、各ノードの役割（{@link schemaRoles}）から
 * フィールド名のラベルと不一致の印を出す。公開サイトは同じスキーマで
 * レコードを読む（application/siteSchema.ts）。
 */
import { closedStringSet } from "./isKeyOf";
import {
  cloneDocument,
  generateId,
  isStoredNodeType,
  type IdSource,
  type MindMapDocument,
  type MindMapModel,
  type NodeType,
} from "./model";

/** フィールドの型。`NodeType` に、ノードの形では表せない値の型を足したもの。 */
export type FieldType = NodeType | "check" | "number" | "date";

const { is: isFieldType, values: FIELD_TYPES } = closedStringSet({
  text: true,
  image: true,
  link: true,
  markdown: true,
  check: true,
  number: true,
  date: true,
} as const satisfies Record<FieldType, true>);
export { isFieldType, FIELD_TYPES };

export interface SchemaField {
  key: string;
  /** 注釈された型（`list` なら各要素の型）。無ければ何でも受け入れる。 */
  type?: FieldType;
  /** `key[]`: フィールドノードの子を並びとして読む。 */
  list: boolean;
  /** `key[]{…}`: 並びの各要素がこのフィールドを持つレコード。`list` のときだけ。 */
  fields?: SchemaField[];
}
export type BranchSchema = SchemaField[];

export const RESERVED_KEYS = ["id", "title"] as const;

const KEY_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export type ParseSchemaResult = { ok: true; schema: BranchSchema } | { ok: false; error: string };

/** 括弧の外にある `,` / 改行で区切る。括弧が閉じていなければ null。 */
function splitTopLevel(text: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth < 0) return null;
    } else if (depth === 0 && (ch === "," || ch === "\n")) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (depth !== 0) return null;
  parts.push(text.slice(start));
  return parts;
}

const FIELD_RE = /^([^:\s[\]{}]+)\s*(\[\])?\s*(?::\s*([A-Za-z]+)|\{([\s\S]*)\})?$/;

export function parseSchema(text: string): ParseSchemaResult {
  const parts = splitTopLevel(text);
  if (!parts) return { ok: false, error: "括弧 { } の対応が取れていません" };
  const schema: BranchSchema = [];
  const seen = new Set<string>();
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    const m = part.match(FIELD_RE);
    if (!m) return { ok: false, error: `フィールドの書式が不正: "${part}"` };
    const [, key, listMark, type, inner] = m;
    if (!KEY_RE.test(key)) return { ok: false, error: `キーに使えない名前: "${key}"` };
    if ((RESERVED_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `"${key}" は予約されています` };
    }
    if (seen.has(key)) return { ok: false, error: `キーが重複: "${key}"` };
    if (type !== undefined && !isFieldType(type)) {
      return { ok: false, error: `不明な型: "${type}"（${FIELD_TYPES.join(" / ")}）` };
    }
    const field: SchemaField = { key, type, list: !!listMark };
    if (inner !== undefined) {
      if (!listMark) return { ok: false, error: `"${key}{…}" は "${key}[]{…}" と書いてください` };
      const sub = parseSchema(inner);
      if (!sub.ok) return sub;
      field.fields = sub.schema;
    }
    seen.add(key);
    schema.push(field);
  }
  return { ok: true, schema };
}

export function formatSchema(schema: BranchSchema): string {
  return schema
    .map((f) => {
      const list = f.list ? "[]" : "";
      if (f.fields) return `${f.key}${list}{${formatSchema(f.fields)}}`;
      return `${f.key}${list}${f.type && f.type !== "text" ? `:${f.type}` : ""}`;
    })
    .join(", ");
}

/** ノード自身のスキーマ。未設定・不正・空なら null（不正な文字列は無いものとして読む）。 */
export function ownSchema(node: MindMapModel): BranchSchema | null {
  if (!node.schema) return null;
  const parsed = parseSchema(node.schema);
  return parsed.ok && parsed.schema.length > 0 ? parsed.schema : null;
}

// --- Roles ---

/**
 * スキーマから見たノードの役割。
 * - `record`: コレクションの子。`fields` がその子に対応する
 * - `field`: レコードの子の index `index`（< fields.length）
 * - `item`: 型付きの並び `key[]:type` の要素
 */
export type SchemaRole =
  | { kind: "record"; collectionId: string; fields: BranchSchema }
  | { kind: "field"; recordId: string; index: number; field: SchemaField }
  | { kind: "item"; field: SchemaField };

/** この役割のノードの子がレコードになるなら、そのフィールド。 */
function recordFieldsFor(node: MindMapModel, role: SchemaRole | undefined): BranchSchema | null {
  const own = ownSchema(node);
  if (own) return own;
  if (role?.kind === "field" && role.field.list && role.field.fields) return role.field.fields;
  return null;
}

/**
 * 文書中の全ノードの役割（役割の無いノードは入らない）。折りたたみは無視する。
 * 自分のスキーマを持つノードは、どの位置にいても子をそのスキーマで読む。
 */
export function schemaRoles(doc: MindMapDocument): Map<string, SchemaRole> {
  const roles = new Map<string, SchemaRole>();
  function walk(node: MindMapModel, role: SchemaRole | undefined) {
    if (role) roles.set(node.id, role);
    const fields = recordFieldsFor(node, role);
    node.children.forEach((child, i) => {
      if (fields) {
        walk(child, { kind: "record", collectionId: node.id, fields });
      } else if (role?.kind === "record" && i < role.fields.length) {
        walk(child, { kind: "field", recordId: node.id, index: i, field: role.fields[i] });
      } else if (role?.kind === "field" && role.field.list && role.field.type) {
        walk(child, { kind: "item", field: role.field });
      } else {
        walk(child, undefined);
      }
    });
  }
  for (const root of doc.roots) walk(root, undefined);
  return roles;
}

/** ノードに当たる値の型（`field` なら並びでない値、`item` なら要素）。 */
export function valueTypeOf(role: SchemaRole): FieldType | undefined {
  if (role.kind === "record") return undefined;
  if (role.kind === "field" && role.field.list) return undefined;
  return role.field.type;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isNumberText(text: string): boolean {
  return text.trim() !== "" && Number.isFinite(Number(text.trim()));
}

export function isDateText(text: string): boolean {
  const m = text.trim().match(DATE_RE);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/**
 * ノードが型 `type` の値として読めないなら、その型（＝期待していたもの）を返す。
 * 空の text ノードは「まだ書いていない」なので不一致にしない。
 */
export function fieldIssue(node: MindMapModel, type: FieldType | undefined): FieldType | null {
  if (!type) return null;
  const kind = node.type ?? "text";
  const blank = kind === "text" && node.text === "";
  switch (type) {
    case "check":
      return node.checked === undefined ? type : null;
    case "number":
      return !blank && (kind !== "text" || !isNumberText(node.text)) ? type : null;
    case "date":
      return !blank && (kind !== "text" || !isDateText(node.text)) ? type : null;
    default:
      return !blank && kind !== type ? type : null;
  }
}

// --- Scaffolding ---

/** 型を空のノードに当てる（IN PLACE）。`number` / `date` はノードの形では表さない。 */
function applyFieldType(node: MindMapModel, type: FieldType | undefined): void {
  if (type === "check") node.checked = false;
  else if (type && isStoredNodeType(type)) node.type = type;
}

/** フィールド 1 つ分の空ノード。 */
export function newFieldNode(field: SchemaField, nextId: IdSource = generateId): MindMapModel {
  const node: MindMapModel = { id: nextId(), text: "", children: [] };
  if (!field.list) applyFieldType(node, field.type);
  return node;
}

function isUntouched(node: MindMapModel): boolean {
  return (
    node.text === "" &&
    node.children.length === 0 &&
    node.type === undefined &&
    node.checked === undefined
  );
}

function parentMap(doc: MindMapDocument): Map<string, string | null> {
  const parents = new Map<string, string | null>();
  function walk(node: MindMapModel, parentId: string | null) {
    parents.set(node.id, parentId);
    for (const c of node.children) walk(c, node.id);
  }
  for (const root of doc.roots) walk(root, null);
  return parents;
}

/**
 * `prev` → `next` の編集で新しく現れた・親が変わったノードを、スキーマに
 * 合わせる。
 * - レコードの位置に入ってきたノード: 足りないフィールドを末尾に補う
 *   （既にある子は変えない。index は位置で決まるので、前を埋めることはしない）
 * - フィールド / 型付き並びの要素の位置に**新しく作られた空の**ノード: その型にする
 *
 * 変えるものが無ければ `next` をそのまま返す（参照同一）。
 */
export function conformEntering(
  prev: MindMapDocument,
  next: MindMapDocument,
  nextId: IdSource = generateId
): MindMapDocument {
  const before = parentMap(prev);
  const after = parentMap(next);
  const roles = schemaRoles(next);
  const pads: { id: string; fields: BranchSchema }[] = [];
  const typings: { id: string; type: FieldType }[] = [];
  const nodes = new Map<string, MindMapModel>();
  (function index(list: MindMapModel[]) {
    for (const n of list) {
      nodes.set(n.id, n);
      index(n.children);
    }
  })(next.roots);

  for (const [id, parentId] of after) {
    const entered = !before.has(id) || before.get(id) !== parentId;
    if (!entered) continue;
    const role = roles.get(id);
    if (!role) continue;
    const node = nodes.get(id)!;
    if (role.kind === "record") {
      if (node.children.length < role.fields.length) pads.push({ id, fields: role.fields });
    } else if (!before.has(id) && isUntouched(node)) {
      const type = valueTypeOf(role);
      if (type && type !== "text" && type !== "number" && type !== "date") typings.push({ id, type });
    }
  }
  if (pads.length === 0 && typings.length === 0) return next;

  const cloned = cloneDocument(next);
  const byId = new Map<string, MindMapModel>();
  (function index(list: MindMapModel[]) {
    for (const n of list) {
      byId.set(n.id, n);
      index(n.children);
    }
  })(cloned.roots);
  for (const { id, type } of typings) applyFieldType(byId.get(id)!, type);
  for (const { id, fields } of pads) {
    const record = byId.get(id)!;
    for (let i = record.children.length; i < fields.length; i++) {
      record.children.push(newFieldNode(fields[i], nextId));
    }
  }
  return cloned;
}
