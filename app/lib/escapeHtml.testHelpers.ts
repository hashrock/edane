/** Inverse of escapeHtml: `&amp;` must be undone last, or a literal "&lt;" in
 *  the input (itself escaped to "&amp;lt;") would be mistaken for a `<` that
 *  survived escaping. Shared by escapeHtml.property.test.ts (the escaper's
 *  own contract) and siteTemplate.property.test.ts (the title embedding it)
 *  so the two can't drift into checking against different inverses. */
export function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}
