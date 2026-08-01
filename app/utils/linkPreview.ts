/**
 * The link-preview endpoint fetches an arbitrary page's HTML server-side (to
 * avoid CORS) and needs its <title> and favicon URL. Extracting those from
 * raw HTML is pure string/regex work with no dependency on fetch or the
 * request lifecycle; pulled out of app/server.ts so the extraction rules
 * (whitespace collapsing, title truncation, favicon rel-matching, the
 * favicon.ico fallback) are testable without a network call.
 */

export function extractLinkPreview(html: string, target: URL): { title: string; favicon: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch
    ? titleMatch[1].replace(/\s+/g, " ").trim().slice(0, 300)
    : target.hostname;

  let favicon: string | null = null;
  for (const tag of html.match(/<link[^>]+>/gi) ?? []) {
    if (/rel=["'][^"']*icon[^"']*["']/i.test(tag)) {
      const href = tag.match(/href=["']([^"']+)["']/i);
      if (href) {
        favicon = new URL(href[1], target).toString();
        break;
      }
    }
  }
  if (!favicon) favicon = `${target.protocol}//${target.host}/favicon.ico`;

  return { title, favicon };
}
