/**
 * Application layer: 公開サイトが枝のスキーマ（domain/branchSchema.ts）で
 * レコードを読む部分。
 *
 * 枝の 2 階層目 = 1 レコード、3 階層目 = そのフィールド（順序で対応）。
 * テンプレートは木を歩いて type で分岐する代わりに `items` を for で回して
 * `item.image` のようにキーで読める。
 *
 * スキーマはマインドマップの枝（公開したノードの `schema`）に持つ。エディタも
 * 同じスキーマでフィールドのラベル・雛形・不一致の印を出すので、書く側と
 * 読む側の食い違いが無い。枝にスキーマが無ければ実データから推定する。
 */
import { findNode, setNodeSchema, STORED_NODE_TYPES, type MindMapDocument } from "../domain/model";
import {
  fieldIssue,
  formatSchema,
  isNumberText,
  ownSchema,
  parseSchema,
  RESERVED_KEYS,
  type BranchSchema,
  type FieldType,
  type SchemaField,
} from "../domain/branchSchema";
import type { SiteNode } from "./siteNode";

export { formatSchema, parseSchema, RESERVED_KEYS, type SchemaField };
export type SiteSchema = BranchSchema;

/**
 * 旧 `sites.schema`（サイト側に持っていたスキーマ）を公開した枝へ移した文書。
 * 枝が既にスキーマを持っていれば枝が勝つ。移すものが無ければ null。
 * サーバーがサイトエディタを開いたときに一度だけ呼ぶ（遅延移行）。
 */
export function migrateSiteSchema(
  doc: MindMapDocument,
  nodeId: string,
  legacySchema: string
): MindMapDocument | null {
  if (!legacySchema.trim()) return null;
  const node = findNode(doc, nodeId);
  if (!node || node.schema) return null;
  return setNodeSchema(doc, nodeId, legacySchema);
}

/**
 * 実データからスキーマの下書きを推定する。各位置について、レコードの過半で
 * 現れる type を注釈にし、キー名は type から（image / url / field1…）。
 * 子を持つノードが過半なら配列とみなす。
 */
export function inferSchema(root: SiteNode): SiteSchema {
  const records = root.children;
  const width = Math.max(0, ...records.map((r) => r.children.length));
  const schema: SiteSchema = [];
  const used = new Set<string>();
  for (let i = 0; i < width; i++) {
    const at = records.map((r) => r.children[i]).filter((n): n is SiteNode => !!n);
    const count = (pred: (n: SiteNode) => boolean) => at.filter(pred).length;
    const majority = (n: number) => n * 2 > at.length;
    const type = STORED_NODE_TYPES.find((t) => majority(count((n) => n.type === t)));
    const base = type === "image" ? "image" : type === "link" ? "url" : type === "markdown" ? "body" : "field";
    let key = base === "field" ? `field${i + 1}` : base;
    for (let n = 2; used.has(key); n++) key = `${base}${n}`;
    used.add(key);
    schema.push({ key, type });
  }
  return schema;
}

/**
 * レコードのフィールド値。`check` は真偽、`number` は数値。フィールドノード
 * 自身がスキーマを持てば、その子をレコードとして読んだ配列（入れ子）。
 */
export type SiteValue = string | number | boolean | SiteItem[];

/** テンプレートが `items` として受け取る 1 レコード。 */
export type SiteItem = { id: string; title: string } & { [key: string]: SiteValue | undefined };

/** SiteNode は MindMapModel の部分集合なので、ドメインの判定にそのまま渡せる。 */
const issueOf = (node: SiteNode, type: FieldType | undefined) =>
  fieldIssue({ ...node, type: node.type === "text" ? undefined : node.type, children: [] }, type);

function scalarValue(node: SiteNode, type: FieldType | undefined): SiteValue | undefined {
  if (type === "check") return node.checked === true;
  if (type === "number") return isNumberText(node.text) ? Number(node.text.trim()) : undefined;
  return node.text;
}

/**
 * 枝をスキーマで読んでレコードの配列にする。足りないフィールドは undefined。
 * 警告は「レコード名: 何が」の短文で、マップを直すためのヒント。
 */
export function shapeRecords(root: SiteNode, schema: SiteSchema): { items: SiteItem[]; warnings: string[] } {
  const warnings: string[] = [];
  const shape = (rec: SiteNode, fields: SiteSchema): SiteItem => {
    const item: SiteItem = { id: rec.id, title: rec.text };
    fields.forEach((f, i) => {
      const node = rec.children[i];
      if (!node) return;
      const nested = ownSchema(node);
      if (nested) {
        item[f.key] = node.children.map((c) => shape(c, nested));
        return;
      }
      if (issueOf(node, f.type)) warnings.push(`${rec.text}: ${f.key} は ${f.type} のはずが ${describeValue(node)}`);
      item[f.key] = scalarValue(node, f.type);
    });
    if (rec.children.length > fields.length) {
      warnings.push(`${rec.text}: スキーマより ${rec.children.length - fields.length} 個多い子があります`);
    }
    return item;
  };
  const items = root.children.map((rec) => shape(rec, schema));
  return { items, warnings };
}

function describeValue(node: SiteNode): string {
  if (node.type !== "text") return node.type;
  return `"${node.text.length > 20 ? `${node.text.slice(0, 20)}…` : node.text}"`;
}

/**
 * Non-list field markup by type, keyed on `FieldType` so a new type has to say
 * how it looks in the generated card here — same `satisfies Record<FieldType,
 * …>` idiom as `FIELD_TYPES` above (and `EDIT_SURFACE` / `STORED_NODE_TYPE_SET`
 * / `NODE_TYPE_LABEL` elsewhere): adding a member to `FieldType` now refuses to
 * compile until this table decides its rendering, instead of it silently
 * falling into the generic `<p>` branch below.
 */
const FIELD_RENDERERS = {
  check: (key: string) => `      {item.${key} !== undefined && <p class="text-sm">{item.${key} ? "✅" : "⬜"} ${key}</p>}`,
  number: (key: string) => `      {item.${key} !== undefined && <p class="text-slate-600 text-sm tabular-nums">{item.${key}}</p>}`,
  date: (key: string) => `      {item.${key} && <time class="text-slate-500 text-xs">{item.${key}}</time>}`,
  image: (key: string) =>
    `      {item.${key} && <img src={item.${key}} class="rounded-lg max-h-48 w-full object-cover" />}`,
  link: (key: string) =>
    `      {item.${key} && <a href={item.${key}} class="text-emerald-700 underline break-all">{item.${key}}</a>}`,
  text: (key: string) => `      {item.${key} && <p class="text-slate-600 text-sm">{item.${key}}</p>}`,
  markdown: (key: string) => `      {item.${key} && <p class="text-slate-600 text-sm">{item.${key}}</p>}`,
} as const satisfies Record<FieldType, (key: string) => string>;

/**
 * スキーマから既定テンプレートを生成する。フィールドの種別に応じたタグで
 * 並べるだけの素直なカード一覧。スキーマが空なら title だけのカード。
 */
export function defaultTemplate(schema: SiteSchema): string {
  const field = (f: SchemaField): string => FIELD_RENDERERS[f.type ?? "text"](f.key);
  return `import { items, title } from './data.js';

function Card({ item }) {
  return (
    <article data-card class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm space-y-2">
      <h2 class="font-semibold text-slate-900">{item.title}</h2>
${schema.map(field).join("\n")}
    </article>
  );
}

export default function Page() {
  return (
    <main class="min-h-screen bg-slate-50 p-6 font-sans">
      <h1 class="text-2xl font-bold text-slate-900">{title}</h1>
      <input data-search placeholder="検索…" class="mt-4 w-full rounded-lg border border-slate-300 px-3 py-2" />
      <div class="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => <Card item={item} />)}
      </div>
    </main>
  );
}
`;
}
