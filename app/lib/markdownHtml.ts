/**
 * Markdown → sanitized HTML for the rendered preview panel.
 *
 * `marked` gives full-fidelity block + inline rendering (headings, lists,
 * tables, code fences, emphasis, links) that the canvas card can't; DOMPurify
 * strips anything unsafe so a shared/public note can't inject script. Both run
 * client-side only (the panel is never server-rendered), so this module must not
 * be imported from the measurement/layout path — see application/markdownCard.ts
 * for the dependency-free card helpers.
 */
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: true });

/** Render markdown to sanitized HTML. Returns "" for blank input. */
export function renderMarkdownHtml(src: string): string {
  if (!src.trim()) return "";
  const raw = marked.parse(src, { async: false }) as string;
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
}
