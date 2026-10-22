/**
 * The link-preview endpoint fetches an arbitrary page's HTML server-side (to
 * avoid CORS) and needs its <title> and favicon URL. Extracting those from
 * raw HTML ({@link extractLinkPreview}) is pure string/regex work, testable
 * without a network call; {@link fetchLinkPreview} bounds the fetch itself
 * (redirects, time, bytes read) and takes `fetch` as a parameter for tests.
 */

function resolveUrl(href: string, base: URL): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

export function extractLinkPreview(html: string, target: URL): { title: string; favicon: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch
    ? titleMatch[1].replace(/\s+/g, " ").trim().slice(0, 300)
    : target.hostname;

  let favicon: string | null = null;
  for (const tag of html.match(/<link[^>]+>/gi) ?? []) {
    if (!/rel=["'][^"']*icon[^"']*["']/i.test(tag)) continue;
    const href = tag.match(/href=["']([^"']+)["']/i);
    if (!href) continue;
    // A malformed href (e.g. "http://[") must not sink the whole preview —
    // the title is still good — so skip it and try the next icon link.
    favicon = resolveUrl(href[1], target);
    if (favicon) break;
  }
  if (!favicon) favicon = `${target.protocol}//${target.host}/favicon.ico`;

  return { title, favicon };
}

/** How much of a page is read looking for <title> / icons (both live in <head>). */
export const LINK_PREVIEW_MAX_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 5000;

/** The first `maxBytes` of a response body as text; the rest is never downloaded. */
export async function readTextPrefix(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  const bytes = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const c of chunks) {
    const part = c.subarray(0, bytes.length - offset);
    bytes.set(part, offset);
    offset += part.byteLength;
    if (offset >= bytes.length) break;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Fetch a page's preview. The endpoint is open (the guest editor uses it), so
 * one call is bounded: http(s) only, at most {@link MAX_REDIRECTS} redirects
 * (each re-checked), {@link TIMEOUT_MS}, and {@link LINK_PREVIEW_MAX_BYTES} read.
 * Null when the page can't be fetched; the caller says so without details.
 */
export async function fetchLinkPreview(
  target: URL,
  fetchImpl: typeof fetch = fetch
): Promise<{ title: string; favicon: string } | null> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let url = target;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const res = await fetchImpl(url.toString(), {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; edane-bot/1.0)" },
      redirect: "manual",
      signal,
    });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("Location") : null;
    if (location) {
      await res.body?.cancel();
      const next = resolveUrl(location, url);
      if (!next) return null;
      url = new URL(next);
      continue;
    }
    return extractLinkPreview(await readTextPrefix(res, LINK_PREVIEW_MAX_BYTES), url);
  }
  return null;
}
