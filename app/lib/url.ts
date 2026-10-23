/**
 * Absolute URLs are built in a few unrelated modules (public note links, node
 * publication URLs, web page URLs, scenario fixtures) that each take a
 * `window.location.origin`-shaped string and a path and need the SAME rule:
 * don't double up the slash when `origin` already ends with one. One place
 * for that rule keeps the call sites from drifting if it ever needs a fix.
 *
 * @param origin `window.location.origin` (or an equivalent base), with or
 *   without a trailing slash.
 * @param path The path to append, starting with `/`.
 */
export function absoluteUrl(origin: string, path: string): string {
  return `${origin.replace(/\/+$/, "")}${path}`;
}

/**
 * A user-supplied URL (a link node's text, a favicon from a fetched page) that
 * is safe to navigate to or load: http(s) only, parsed and re-serialized.
 * `javascript:`, `data:` and anything unparseable give null, so a link from a
 * shared or public note can't run script. Every place that opens or renders
 * such a URL goes through here (app/externalLinks.test.ts keeps it that way).
 */
export function safeExternalUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
