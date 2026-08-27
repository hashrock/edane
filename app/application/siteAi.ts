/**
 * Application layer: 公開サイトのテンプレートを AI（Workers AI）に提案させる
 * ためのプロンプト組み立てと応答の後処理。モデル呼び出し自体はサーバー
 * （server.ts の /api/sites/:pubId/suggest）にあり、ここは純粋関数だけ。
 */
import type { SiteNode } from "./siteTemplate";
import { defaultTemplate, formatSchema, parseSchema, inferSchema, shapeRecords, type SiteSchema, type SiteItem } from "./siteSchema";

export const SITE_AI_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";

/** プロンプトに載せるデータの上限（トークン節約。枝が大きくても先頭だけ見せる）。 */
export const SITE_AI_DATA_MAX_CHARS = 6000;
export const SITE_AI_INSTRUCTION_MAX_CHARS = 1000;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * `items` の先頭数件を、長い値を切り詰めて JSON にする。モデルには木ではなく
 * テンプレートが実際に受け取る形だけを見せる（木を見せると data.children を
 * 歩き始める）。
 */
export function sampleItems(items: SiteItem[], maxChars = SITE_AI_DATA_MAX_CHARS): string {
  const clip = (v: string) => (v.length > 120 ? v.slice(0, 120) + "…" : v);
  const shown = items.slice(0, 5).map((item) =>
    Object.fromEntries(
      Object.entries(item).map(([k, v]) => [k, Array.isArray(v) ? v.slice(0, 8).map(clip) : v === undefined ? undefined : clip(v)])
    )
  );
  const json = JSON.stringify(shown, null, 1);
  const note = items.length > 5 ? `\n…(+${items.length - 5} more items)` : "";
  return (json.length > maxChars ? json.slice(0, maxChars) + "\n…(truncated)" : json) + note;
}

const SYSTEM_PROMPT = `You design small static web pages from a list of records, written as a JSX template.

Runtime contract (strict):
- Output ONE file, index.jsx. It must begin with: import { items, title } from './data.js';
- \`title\` is the page heading (string). \`items\` is an array of records whose fields are described by the schema in the user message. Render the list as \`items.map((item) => …)\` and read fields by key: item.title, item.<key>. Fields may be undefined; guard with \`&&\`. List fields (string[]) are rendered with .map.
- These two are the ONLY exports of data.js. There is no tree, no \`children\`, no \`type\`, no \`data\`.
- Export a default function component that returns the page body (no <html>/<head>/<body>).
- JSX is compiled by TypeScript with factory \`h\`; use \`class\` for CSS classes. Components are plain functions taking props. No hooks, no state, no event handlers, no <script>, no imports other than './data.js', no fetch.
- Styling: UnoCSS / Tailwind utility classes only (they are generated from the markup). No <style> blocks.
- Search (REQUIRED): render exactly one \`<input data-search placeholder="…">\`, and put the \`data-card\` attribute on the outermost element of EVERY record. The hosting page injects a script that filters [data-card] elements by the text typed into [data-search]; without these attributes search is broken.
- Never nest cards inside cards.

Design guidance:
- Read the schema and the sample items to understand what each field means (description, URL, image, price, date, tags…) and lay it out accordingly: images as <img>, URLs as <a>, lists as chips, etc.
- Choose a look that suits the content (catalog, directory, gallery, timeline, FAQ…), with a clear heading using title, good spacing, responsive grid, readable typography. Be tasteful, not gaudy.
- Reply with ONLY the JSX code in a single \`\`\`jsx fenced block. No explanations.`;

export interface SuggestRequest {
  instruction: string;
  /** 作者のテンプレート。既定のまま／空なら「まだ何もない」として扱う。 */
  currentTemplate: string;
  /** スキーマ文字列（空なら推定）。 */
  schema: string;
}

/** `/api/sites/:id/suggest` のボディ。型が違えば黙って既定値にする（内容は AI が読むだけ）。 */
export function validateSuggestRequest(body: unknown): SuggestRequest {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  return {
    instruction: typeof b.instruction === "string" ? b.instruction : "",
    currentTemplate: typeof b.template === "string" ? b.template : "",
    schema: typeof b.schema === "string" ? b.schema : "",
  };
}

/**
 * 既定テンプレートは「現在のテンプレート」として見せない — 見せると色替え
 * だけの提案に引きずられ、ゼロから考えなくなる。
 */
function authoredTemplate(template: string, schema: SiteSchema): string {
  const t = template.trim();
  return t === defaultTemplate(schema).trim() ? "" : t;
}

/** 空／不正なスキーマは推定で補う（サーバーもエディタも同じ規則）。 */
export function effectiveSchema(schemaText: string, data: SiteNode): SiteSchema {
  const parsed = parseSchema(schemaText);
  return parsed.ok && parsed.schema.length ? parsed.schema : inferSchema(data);
}

function describeItems(schema: SiteSchema): string {
  const fields = schema
    .map((f) => `  ${f.key}: ${f.list ? "string[]" : "string"} | undefined${f.type && f.type !== "text" ? `  // ${f.type} URL` : ""}`)
    .join("\n");
  return `{\n  id: string,\n  title: string,\n${fields}\n}`;
}

export function buildSuggestMessages(input: SuggestRequest & { data: SiteNode }): ChatMessage[] {
  const instruction = input.instruction.trim().slice(0, SITE_AI_INSTRUCTION_MAX_CHARS);
  const schema = effectiveSchema(input.schema, input.data);
  const current = authoredTemplate(input.currentTemplate, schema);
  const user =
    `Schema (field order = child order): ${formatSchema(schema) || "(none)"}\n` +
    `Each element of \`items\` has the shape:\n\`\`\`ts\n${describeItems(schema)}\n\`\`\`\n\n` +
    `title: ${JSON.stringify(input.data.text)}\n` +
    `Sample of items:\n\`\`\`json\n${sampleItems(shapeRecords(input.data, schema).items)}\n\`\`\`\n\n` +
    (current
      ? `Current template (the author's work so far — keep its intent, improve it or restructure as requested):\n\`\`\`jsx\n${current.slice(0, 4000)}\n\`\`\`\n\n`
      : "") +
    (instruction ? `Author's request: ${instruction}\n\n` : "") +
    `Write index.jsx.`;
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

export type ExtractResult =
  | { kind: "ok"; template: string }
  /** 途中で切れた応答（閉じフェンスが無い / finish_reason=length）。 */
  | { kind: "truncated" }
  /** コードらしきものが無い。 */
  | { kind: "none" };

/**
 * モデル応答からテンプレート本文を取り出す。Qwen3 の <think>…</think> と
 * コードフェンスを剥がし、data.js の import が無ければ先頭に補う。
 *
 * 途中で切れた応答（開きフェンスだけで閉じが無い、または呼び出し側が
 * `truncated` と判定）は "truncated" にして、壊れたコードを返さない。
 */
export function extractTemplate(
  response: string,
  opts: { truncated?: boolean } = {}
): ExtractResult {
  let s = response.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (/<think>/.test(s)) return { kind: "truncated" }; // 思考の途中で切れた
  const fence = s.match(/```(?:jsx|tsx|js|javascript)?[^\n]*\n([\s\S]*?)```/);
  if (fence) {
    s = fence[1].trim();
  } else if (/```/.test(s)) {
    return { kind: "truncated" }; // 開きフェンスだけ
  }
  if (opts.truncated) return { kind: "truncated" };
  if (!s || !/export\s+default|function\s+\w+/.test(s)) return { kind: "none" };
  if (!/from\s+['"]\.\/data\.js['"]/.test(s)) {
    s = `import { items, title } from './data.js';\n\n` + s;
  }
  return { kind: "ok", template: s + "\n" };
}
