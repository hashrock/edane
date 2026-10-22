/**
 * HTML-escapes text for embedding inside element content or a double-quoted
 * attribute. The one place this rule lives — `notFoundPage.ts` (404 page) and
 * `siteTemplate.ts` (public site title) used to each carry their own copy, so
 * a future third call site could easily add a variant that misses one of the
 * four characters below (a real XSS gap, not just a style nit).
 */
const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => HTML_ENTITIES[ch]);
}

/**
 * `value` as JSON that is safe inside an HTML `<script>` element (a data block
 * or a module). `<` becomes `<`, so no `</script>` or `<!--` can end or
 * derail the element; U+2028 / U+2029 are escaped for older JS parsers. Still
 * valid JSON, read back with a plain `JSON.parse`.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
