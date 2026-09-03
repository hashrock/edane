/**
 * Application layer: 公開サイトの「スキーマ」。
 *
 * 枝の 2 階層目 = 1 レコード、3 階層目 = そのフィールド（順序で対応）という
 * 読み方はそのままに、フィールドの**位置に名前を付ける**だけの仕組み。
 * テンプレートは木を歩いて type で分岐する代わりに `items` を for で回して
 * `item.image` のようにキーで読める。
 *
 *   title, description, url:link, image:image, tags[]
 *
 * - `key` は識別子。`title` は予約（レコードノード自身の text）
 * - `:type` は任意の注釈。値の形は変えず（常に text の文字列）、実データと
 *   食い違ったら警告に出すためのもの
 * - `[]` はそのフィールドノードの子の text を string[] として読む
 *
 * スキーマはマインドマップ側ではなくサイト側（sites.schema）に持つ。
 * 「まず自由に書く → 後から読み方を決める」ので、同じ枝を別のスキーマで
 * 読む 2 つのサイトも作れる。
 */
import { STORED_NODE_TYPES, type NodeType } from "../domain/model";
import { isKeyOf } from "../domain/isKeyOf";
import type { SiteNode } from "./siteNode";

export interface SchemaField {
  key: string;
  /** 注釈された種別。無ければ何でも受け入れる。 */
  type?: NodeType;
  /** `key[]`: 子ノードの text の配列として読む。 */
  list: boolean;
}
export type SiteSchema = SchemaField[];

export const RESERVED_KEYS = ["id", "title"] as const;

const FIELD_TYPES = { text: true, image: true, link: true, markdown: true } as const satisfies Record<
  NodeType,
  true
>;
const KEY_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function parseSchema(text: string): { ok: true; schema: SiteSchema } | { ok: false; error: string } {
  const schema: SiteSchema = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[,\n]/)) {
    const part = raw.trim();
    if (!part) continue;
    const m = part.match(/^([^:\s[\]]+)(\[\])?(?::\s*([A-Za-z]+))?$/);
    if (!m) return { ok: false, error: `フィールドの書式が不正: "${part}"` };
    const [, key, listMark, type] = m;
    if (!KEY_RE.test(key)) return { ok: false, error: `キーに使えない名前: "${key}"` };
    if ((RESERVED_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `"${key}" は予約されています` };
    }
    if (seen.has(key)) return { ok: false, error: `キーが重複: "${key}"` };
    if (type && !isKeyOf(FIELD_TYPES, type)) {
      return { ok: false, error: `不明な種別: "${type}"（text / image / link / markdown）` };
    }
    seen.add(key);
    schema.push({ key, type: type as NodeType | undefined, list: !!listMark });
  }
  return { ok: true, schema };
}

export function formatSchema(schema: SiteSchema): string {
  return schema
    .map((f) => `${f.key}${f.list ? "[]" : ""}${f.type && f.type !== "text" ? `:${f.type}` : ""}`)
    .join(", ");
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
    const list = majority(count((n) => n.children.length > 0));
    let base = type === "image" ? "image" : type === "link" ? "url" : type === "markdown" ? "body" : list ? "items" : "field";
    let key = base === "field" ? `field${i + 1}` : base;
    for (let n = 2; used.has(key); n++) key = `${base}${n}`;
    used.add(key);
    schema.push({ key, type, list });
  }
  return schema;
}

/** テンプレートが `items` として受け取る 1 レコード。 */
export type SiteItem = { id: string; title: string } & Record<string, string | string[] | undefined>;

/**
 * 枝をスキーマで読んでレコードの配列にする。足りないフィールドは undefined。
 * 警告は「レコード名: 何が」の短文で、マップを直すためのヒント。
 */
export function shapeRecords(root: SiteNode, schema: SiteSchema): { items: SiteItem[]; warnings: string[] } {
  const warnings: string[] = [];
  const items = root.children.map((rec) => {
    const item: SiteItem = { id: rec.id, title: rec.text };
    schema.forEach((f, i) => {
      const node = rec.children[i];
      if (!node) return;
      if (f.type && node.type !== f.type) {
        warnings.push(`${rec.text}: ${f.key} は ${f.type} のはずが ${node.type}`);
      }
      item[f.key] = f.list ? node.children.map((c) => c.text) : node.text;
    });
    if (rec.children.length > schema.length) {
      warnings.push(`${rec.text}: スキーマより ${rec.children.length - schema.length} 個多い子があります`);
    }
    return item;
  });
  return { items, warnings };
}

/**
 * Non-list field markup by kind, keyed on `NodeType` so a new kind has to say
 * how it looks in the generated card here — same `satisfies Record<NodeType,
 * …>` idiom as `FIELD_TYPES` above (and `EDIT_SURFACE` / `STORED_NODE_TYPE_SET`
 * / `NODE_TYPE_LABEL` elsewhere): adding a member to `NodeType` now refuses to
 * compile until this table decides its rendering, instead of it silently
 * falling into the generic `<p>` branch below.
 */
const FIELD_RENDERERS = {
  image: (key: string) =>
    `      {item.${key} && <img src={item.${key}} class="rounded-lg max-h-48 w-full object-cover" />}`,
  link: (key: string) =>
    `      {item.${key} && <a href={item.${key}} class="text-emerald-700 underline break-all">{item.${key}}</a>}`,
  text: (key: string) => `      {item.${key} && <p class="text-slate-600 text-sm">{item.${key}}</p>}`,
  markdown: (key: string) => `      {item.${key} && <p class="text-slate-600 text-sm">{item.${key}}</p>}`,
} as const satisfies Record<NodeType, (key: string) => string>;

/**
 * スキーマから既定テンプレートを生成する。フィールドの種別に応じたタグで
 * 並べるだけの素直なカード一覧。スキーマが空なら title だけのカード。
 */
export function defaultTemplate(schema: SiteSchema): string {
  const field = (f: SchemaField): string => {
    if (f.list) {
      return `      {(item.${f.key} ?? []).map((v) => <span class="mr-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{v}</span>)}`;
    }
    return FIELD_RENDERERS[f.type ?? "text"](f.key);
  };
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
