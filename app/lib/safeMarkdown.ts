/**
 * Markdown → HTML that is safe without a DOM, for the page view (Webページ /
 * スライド), which the server renders too — DOMPurify (lib/markdownHtml.ts)
 * needs a document, and Workers have none.
 *
 * `marked` escapes all text itself; the only ways for markup to get through
 * are raw HTML tokens and URLs. So raw HTML is rendered as escaped text and
 * every link / image URL must be http(s) or a same-origin path — anything
 * else (`javascript:`, `data:`, …) is dropped. The published page's CSP (no
 * inline script) stays as the second line of defence.
 */
import { Marked } from "marked";
import { escapeHtml } from "./escapeHtml";
import { safeExternalUrl } from "./url";

/** A URL a page may link to or load: http(s), or a path on this origin. */
export function safePageUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\")) return raw;
  return safeExternalUrl(raw);
}

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html: ({ text }) => escapeHtml(text),
  },
  walkTokens: (token) => {
    if (token.type === "link" || token.type === "image") token.href = safePageUrl(token.href) ?? "";
  },
});

/** Render markdown to HTML with no raw HTML and only safe URLs. "" for blank input. */
export function renderSafeMarkdown(src: string): string {
  if (!src.trim()) return "";
  return marked.parse(src, { async: false }) as string;
}
