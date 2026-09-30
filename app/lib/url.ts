/**
 * Absolute URLs are built in a few unrelated modules (public note links, node
 * publication URLs, site URLs, scenario fixtures) that each take a
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
