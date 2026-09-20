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
import { shapeRecords, type SiteSchema } from "./siteSchema";
import type { SiteNode } from "./siteNode";

/** テンプレートが `import { data } from './data.js'` で読む仮想ファイル。 */
export const SITE_DATA_FILE = "data.js";
export const SITE_ENTRY_FILE = "index.jsx";

/**
 * `data`（生の木）、`title`（枝の見出し）、`items`（スキーマで整形した
 * レコード）を export する。
 * スキーマが空なら実データから推定したもので整形するので、`items` は常に使える。
 */
export function siteDataModule(root: SiteNode, schema: SiteSchema): string {
  // `</script>` を含む文字列でも安全なように、JSON 内の `<` をエスケープする。
  const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");
  const { items } = shapeRecords(root, schema);
  return (
    `export const data = ${json(root)};\n` +
    `export const title = ${json(root.text)};\n` +
    `export const items = ${json(items)};\n` +
    `export const schema = ${json(schema)};\n`
  );
}

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
export const SITE_SCHEMA_MAX_BYTES = 4 * 1024;
export const SITE_BUILD_MAX_BYTES = 2 * 1024 * 1024;

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * `parts` の UTF-8 バイト数の合計が `limit` を超えるか。
 *
 * 上限は保存先（D1 の TEXT 列）が実際に食う量の話なので、`.length`（UTF-16
 * コードユニット数）では測れない——日本語なら1文字3バイト、絵文字なら4バイトで、
 * `.length` 比較は上限の 1/3 しか守っていなかった。
 *
 * ただし UTF-8 は1コードユニットあたり1〜3バイトなので、大半はコードユニット数
 * だけで決着がつく。2MB のビルド成果物を毎回 `Uint8Array` に符号化しないための
 * 挟み込み（ASCII 主体の実際の成果物は一度も符号化されない）。この上下限は
 * 部分ごとの合計でもそのまま成り立つ。
 *
 * 数えるのは**各 part を別々に符号化したバイト数の合計**で、連結してから
 * 符号化した長さではない。html と css は別々の TEXT 列に入るので、それが実際に
 * 食う量。両者は一致しないことがある——`parts[0]` が上位サロゲートで終わり
 * `parts[1]` が下位サロゲートで始まると、連結時だけ対になって 3+3=6 バイトが
 * 4バイトに縮む。
 */
export function exceedsBytes(limit: number, ...parts: string[]): boolean {
  let units = 0;
  for (const p of parts) units += p.length;
  if (units > limit) return true; // bytes >= units
  if (units * 3 <= limit) return false; // bytes <= units * 3
  let bytes = 0;
  for (const p of parts) bytes += utf8ByteLength(p);
  return bytes > limit;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "&quot;"
  );
}

/**
 * id を1つのパスセグメントに符号化する。表現できない id には `undefined`。
 *
 * `encodeURIComponent` は `.` を素通しするので、id が `..` だと URL 正規化が
 * `/sites/../edit` を `/edit` に畳み、パスが `/sites/` の外へ出る。`%2E` へ
 * 逃がしても無駄で、URL 標準はドットセグメントを percent-encoded の綴りごと
 * 同一視する。つまり **`.` / `..` に復号されるセグメントは原理的に作れない**。
 *
 * 投げないのは、呼び出し側が3つともレンダー中のリンク組み立てだから
 * （このアプリに error boundary は無く、throw は画面が真っ白になる）。
 * `undefined` なら `href={undefined}` がリンクを落とすだけで済む。実際の
 * pubId は `crypto.randomUUID()` 由来なのでここには来ない。
 */
function encodePathSegment(id: string): string | undefined {
  return id === "." || id === ".." ? undefined : encodeURIComponent(id);
}

/**
 * 公開サイト関連の URL / パス。ここ以外で `/sites/...` を組み立てない。
 * 1つのパスセグメントにできない id には `undefined`（= リンクを出さない）。
 */
export function siteEditPath(pubId: string): string | undefined {
  const seg = encodePathSegment(pubId);
  // `seg &&` ではなく明示的に比較する（空 id は空セグメントで、falsy だが有効）。
  return seg === undefined ? undefined : `/sites/${seg}/edit`;
}
export function siteUrl(origin: string, pubId: string): string | undefined {
  const seg = encodePathSegment(pubId);
  return seg === undefined ? undefined : `${origin.replace(/\/+$/, "")}/sites/${seg}`;
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
    // `\/` is a CSS escape for `/`, so the author's CSS keeps its meaning while
    // the HTML parser no longer sees an end tag. The match is spliced back in as
    // written: a blanket `"<\\/style"` would lowercase `</STYLE` inside a string
    // or a `content:` value.
    `<style>${build.css.replace(/<\/style/gi, (m) => "<\\" + m.slice(1))}</style></head>` +
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
  | { ok: true; template: string; schema: string; build: SiteBuild }
  | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Invalid body" };
  const { template, schema = "", html, css } = body as Record<string, unknown>;
  if (typeof template !== "string" || typeof html !== "string" || typeof css !== "string" || typeof schema !== "string") {
    return { ok: false, error: "template, html and css are required" };
  }
  if (exceedsBytes(SITE_TEMPLATE_MAX_BYTES, template)) return { ok: false, error: "Template too large" };
  if (exceedsBytes(SITE_SCHEMA_MAX_BYTES, schema)) return { ok: false, error: "Schema too large" };
  if (exceedsBytes(SITE_BUILD_MAX_BYTES, html, css)) return { ok: false, error: "Build too large" };
  return { ok: true, template, schema, build: { html, css } };
}
