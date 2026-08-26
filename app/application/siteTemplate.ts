/**
 * Application layer: 「公開サイト」機能の純粋ロジック。
 *
 * 公開ノード（/pub/:id.json の枝）を JSX テンプレートで静的 HTML に変換し、
 * カード型・検索ありの Web ページとして同一ドメインの /sites/:pubId で配信する。
 *
 * コンパイル（JSX → HTML）はブラウザの Web Worker（components/siteCompiler.worker.ts）
 * でしか走らない。Cloudflare Workers は `new Function` を禁止しているし、typescript
 * を持ち込むのも重すぎるので、SSG と同じく**ビルド済み HTML を保存して配信**する。
 * ここには Worker とサーバーの両方が共有する、DOM 非依存の部分だけを置く。
 */
import type { MindMapModel, NodeType } from "../domain/model";

/**
 * テンプレートに渡すデータ。エディタ内部の MindMapModel をそのまま晒さず、
 * 「枝の形＋順序＋type」だけの薄い形にする（モデルを変えてもテンプレートが壊れない）。
 */
export interface SiteNode {
  id: string;
  /** ノード種別。`text` 以外は `text` の中身が URL / Markdown 本文になる。 */
  type: NodeType;
  text: string;
  children: SiteNode[];
}

export function toSiteNode(node: MindMapModel): SiteNode {
  return {
    id: node.id,
    type: node.type ?? "text",
    text: node.text,
    children: node.children.map(toSiteNode),
  };
}

/** テンプレートが `import { data } from './data.js'` で読む仮想ファイル。 */
export const SITE_DATA_FILE = "data.js";
export const SITE_ENTRY_FILE = "index.jsx";

export function siteDataModule(root: SiteNode): string {
  // `</script>` を含む文字列でも安全なように、JSON 内の `<` をエスケープする。
  return `export const data = ${JSON.stringify(root).replace(/</g, "\\u003c")};\n`;
}

/**
 * 既定テンプレート。2階層目 = 1件のカード、3階層目 = そのフィールドという
 * 読み方。`data-search` / `data-card` は配信時に付与される検索スクリプトの
 * 目印（siteSearchScript）。
 */
export const DEFAULT_SITE_TEMPLATE = `import { data } from './data.js';

function Field({ node }) {
  if (node.type === 'image') return <img src={node.text} class="rounded-lg max-h-48 object-cover" />;
  if (node.type === 'link') return <a href={node.text} class="text-emerald-700 underline break-all">{node.text}</a>;
  return <p class="text-slate-600 text-sm">{node.text}</p>;
}

function Card({ node }) {
  return (
    <article data-card class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm space-y-2">
      <h2 class="font-semibold text-slate-900">{node.text}</h2>
      {node.children.map((c) => <Field node={c} />)}
    </article>
  );
}

export default function Page() {
  return (
    <main class="min-h-screen bg-slate-50 p-6 font-sans">
      <h1 class="text-2xl font-bold text-slate-900">{data.text}</h1>
      <input data-search placeholder="検索…" class="mt-4 w-full rounded-lg border border-slate-300 px-3 py-2" />
      <div class="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {data.children.map((c) => <Card node={c} />)}
      </div>
    </main>
  );
}
`;

/**
 * 配信 HTML に埋め込む検索スクリプト。`input[data-search]` の入力で、
 * テキストが部分一致しない `[data-card]` を隠す。テンプレート側の契約はこの
 * 2つの属性だけ。
 */
export const SITE_SEARCH_SCRIPT = `(function(){
var input=document.querySelector('[data-search]');if(!input)return;
var cards=Array.prototype.slice.call(document.querySelectorAll('[data-card]'));
function norm(s){return (s||'').toLowerCase().replace(/\\s+/g,' ').trim();}
var texts=cards.map(function(c){return norm(c.textContent);});
input.addEventListener('input',function(){
var q=norm(input.value).split(' ').filter(Boolean);
cards.forEach(function(c,i){c.hidden=q.some(function(w){return texts[i].indexOf(w)<0;});});
});
})();`;

/** サーバーに保存し、そのまま配信されるビルド成果物。 */
export interface SiteBuild {
  html: string;
  css: string;
}

export const SITE_TEMPLATE_MAX_BYTES = 64 * 1024;
export const SITE_BUILD_MAX_BYTES = 2 * 1024 * 1024;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "&quot;"
  );
}

/** 公開サイト関連の URL / パス。ここ以外で `/sites/...` を組み立てない。 */
export function siteEditPath(pubId: string): string {
  return `/sites/${encodeURIComponent(pubId)}/edit`;
}
export function siteUrl(origin: string, pubId: string): string {
  return `${origin.replace(/\/+$/, "")}/sites/${encodeURIComponent(pubId)}`;
}

/**
 * 作者の HTML を同一オリジンで配信するので、stored XSS が他ユーザーの
 * セッションに届かないよう二重に守る CSP：
 * - `sandbox allow-scripts allow-popups`（ヘッダのみ）: opaque origin になり
 *   cookie / storage / 同一オリジン API に一切触れない
 * - `script-src 'nonce-…'`: そもそも検索スクリプト以外は実行されない。
 *   こちらは `<meta>` でも文書に埋めるので、プレビュー（srcdoc）でも同じ
 *   ポリシーが効く。
 */
function scriptPolicy(nonce: string): string {
  return (
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; ` +
    `img-src * data: blob:; media-src *; font-src * data:; frame-src 'none'`
  );
}

/**
 * 保存された HTML / CSS を、配信できる完全な文書とヘッダに組み立てる。
 * nonce はここで採番して文書とヘッダの両方に入れるので、呼び出し側が
 * 対を取り違えることはない。プレビューは `body` だけを srcdoc に使う。
 *
 * テンプレートが `<html>` から書いていても入れ子にせず body の中身として
 * 扱う（ono の renderToString は断片を返す前提）。
 */
export function renderSiteResponse(
  build: SiteBuild,
  title: string
): { body: string; headers: Record<string, string> } {
  const nonce = crypto.randomUUID();
  const body =
    "<!DOCTYPE html>" +
    `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta http-equiv="Content-Security-Policy" content="${scriptPolicy(nonce)}">` +
    `<title>${escapeHtml(title)}</title>` +
    `<style>${build.css.replace(/<\/style/gi, "<\\/style")}</style></head>` +
    `<body>${build.html}` +
    `<script nonce="${nonce}">${SITE_SEARCH_SCRIPT}</script></body></html>`;
  return {
    body,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `sandbox allow-scripts allow-popups; ${scriptPolicy(nonce)}`,
      "X-Robots-Tag": "noindex",
      "Referrer-Policy": "no-referrer",
    },
  };
}

/** 保存リクエストの検証。サイズと型だけ（内容は CSP で守る）。 */
export function validateSiteSave(body: unknown):
  | { ok: true; template: string; build: SiteBuild }
  | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Invalid body" };
  const { template, html, css } = body as Record<string, unknown>;
  if (typeof template !== "string" || typeof html !== "string" || typeof css !== "string") {
    return { ok: false, error: "template, html and css are required" };
  }
  if (template.length > SITE_TEMPLATE_MAX_BYTES) return { ok: false, error: "Template too large" };
  if (html.length + css.length > SITE_BUILD_MAX_BYTES) return { ok: false, error: "Build too large" };
  return { ok: true, template, build: { html, css } };
}
