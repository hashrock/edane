/** Inverse of escapeHtml: `&amp;` must be undone last, or a literal "&lt;" in
 *  the input (itself escaped to "&amp;lt;") would be mistaken for a `<` that
 *  survived escaping. Kept apart from escapeHtml.property.test.ts so another
 *  test that checks an embedding can share the same inverse. */
export function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}
