/**
 * HTML-escapes text for embedding inside element content or a double-quoted
 * attribute. The one place this rule lives — `notFoundPage.ts` (404 page) and
 * `siteTemplate.ts` (public site title) used to each carry their own copy, so
 * a future third call site could easily add a variant that misses one of the
 * four characters below (a real XSS gap, not just a style nit).
 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      default:
        return "&quot;";
    }
  });
}
