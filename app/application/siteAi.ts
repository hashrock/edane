/**
 * Application layer: 公開サイトのテンプレートを AI（Workers AI）に提案させる
 * ためのプロンプト組み立てと応答の後処理。モデル呼び出し自体はサーバー
 * （server.ts の /api/sites/:pubId/suggest）にあり、ここは純粋関数だけ。
 */
import { DEFAULT_SITE_TEMPLATE, type SiteNode } from "./siteTemplate";

export const SITE_AI_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";

/** プロンプトに載せるデータの上限（トークン節約。枝が大きくても先頭だけ見せる）。 */
export const SITE_AI_DATA_MAX_CHARS = 6000;
export const SITE_AI_INSTRUCTION_MAX_CHARS = 1000;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * 枝を「構造が分かる程度」に切り詰めた JSON。子が多い場合は先頭数件＋省略印。
 * text は長すぎれば切る。
 */
export function sampleSiteData(root: SiteNode, maxChars = SITE_AI_DATA_MAX_CHARS): string {
  const shrink = (n: SiteNode, depth: number): Record<string, unknown> => {
    const out: Record<string, unknown> = {
      type: n.type,
      text: n.text.length > 120 ? n.text.slice(0, 120) + "…" : n.text,
    };
    if (n.children.length) {
      const limit = depth === 0 ? 6 : 8;
      const shown = n.children.slice(0, limit).map((c) => shrink(c, depth + 1));
      const rest = n.children.length - limit;
      out.children = rest > 0 ? [...shown, `…(+${rest} more)`] : shown;
    }
    return out;
  };
  const json = JSON.stringify(shrink(root, 0), null, 1);
  return json.length > maxChars ? json.slice(0, maxChars) + "\n…(truncated)" : json;
}

const SYSTEM_PROMPT = `You design small static web pages from a tree of notes, written as a JSX template.

Runtime contract (strict):
- Output ONE file, index.jsx. It must begin with: import { data } from './data.js';
- \`data\` is a node: { id, type: "text"|"image"|"link"|"markdown"|"object", text, children: node[] }. For "image" and "link" nodes, \`text\` holds the URL.
- Export a default function component that returns the page body (no <html>/<head>/<body>).
- JSX is compiled by TypeScript with factory \`h\`; use \`class\` for CSS classes. Components are plain functions taking props. No hooks, no state, no event handlers, no <script>, no external imports other than './data.js', no fetch.
- Styling: UnoCSS / Tailwind utility classes only (they are generated from the markup). No <style> blocks.
- Search (REQUIRED): render exactly one \`<input data-search placeholder="…">\`, and put the \`data-card\` attribute on the outermost element of EVERY record (each child of data). The hosting page injects a script that filters [data-card] elements by the text typed into [data-search]; without these attributes search is broken.
- Never nest cards inside cards. Guard against missing children (children may be empty).

Design guidance:
- Read the sample data: the first level under the root is usually one record per node, the level below it is that record's fields (in order). Infer what each field position/type means (title, description, URL, image, price, date…) and lay it out accordingly.
- Choose a look that suits the content (catalog, directory, gallery, timeline, FAQ…), with a clear heading using data.text, good spacing, responsive grid, readable typography. Be tasteful, not gaudy.
- Reply with ONLY the JSX code in a single \`\`\`jsx fenced block. No explanations.`;

export interface SuggestRequest {
  instruction: string;
  /** 作者のテンプレート。既定のまま／空なら「まだ何もない」として扱う。 */
  currentTemplate: string;
}

/** `/api/sites/:id/suggest` のボディ。型が違えば黙って既定値にする（内容は AI が読むだけ）。 */
export function validateSuggestRequest(body: unknown): SuggestRequest {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  return {
    instruction: typeof b.instruction === "string" ? b.instruction : "",
    currentTemplate: typeof b.template === "string" ? b.template : "",
  };
}

/**
 * 既定テンプレートは「現在のテンプレート」として見せない — 見せると色替え
 * だけの提案に引きずられ、ゼロから考えなくなる。
 */
function authoredTemplate(template: string): string {
  const t = template.trim();
  return t === DEFAULT_SITE_TEMPLATE.trim() ? "" : t;
}

export function buildSuggestMessages(input: SuggestRequest & { data: SiteNode }): ChatMessage[] {
  const instruction = input.instruction.trim().slice(0, SITE_AI_INSTRUCTION_MAX_CHARS);
  const current = authoredTemplate(input.currentTemplate);
  const user =
    `Sample of the data (truncated):\n\`\`\`json\n${sampleSiteData(input.data)}\n\`\`\`\n\n` +
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

/**
 * モデル応答からテンプレート本文を取り出す。Qwen3 の <think>…</think> と
 * コードフェンスを剥がし、`import { data }` が無ければ先頭に補う。
 * コードらしきものが取れなければ null。
 */
export function extractTemplate(response: string): string | null {
  let s = response.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const fence = s.match(/```(?:jsx|tsx|js|javascript)?\s*\n([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  if (!s || !/export\s+default|function\s+\w+/.test(s)) return null;
  if (!/from\s+['"]\.\/data\.js['"]/.test(s)) {
    s = `import { data } from './data.js';\n\n` + s;
  }
  return s + "\n";
}
