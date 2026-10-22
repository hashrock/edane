/**
 * Application layer: the theme's author CSS, made safe to drop into a page.
 *
 * The CSS is the note author's, and the editor shows it to everyone who opens
 * a public note — inside the app's own document. So it may style the page view
 * and nothing else:
 *
 *  - it is wrapped in `@scope (<scope>) { … }`, so every rule's subject is the
 *    page view or inside it (the app around it is out of reach; the view's
 *    frame clips and contains what it paints);
 *  - braces must balance (a stray `}` would close the scope and let the rest
 *    style the whole app) — unbalanced CSS is dropped entirely;
 *  - at-rules are allowlisted: `@import` / `@font-face` / `@namespace` / a
 *    nested `@scope` … are removed (no loading other origins' CSS or fonts,
 *    no unscoping); `@keyframes` are hoisted out of the scope, where they are
 *    valid;
 *  - `<` is escaped, so the text can't close the `<style>` element it lives in.
 *
 * Depends on nothing.
 */

const ALLOWED_AT_RULES = new Set(["media", "supports", "container", "keyframes", "-webkit-keyframes"]);
const HOISTED_AT_RULES = new Set(["keyframes", "-webkit-keyframes"]);

/** CSS without comments, or null when a string or comment never ends. */
function stripComments(css: string): string | null {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '"' || ch === "'") {
      const end = stringEnd(css, i);
      if (end < 0) return null;
      out += css.slice(i, end);
      i = end;
    } else if (ch === "\\") {
      // An escape is one character of an identifier, never a brace or quote.
      out += css.slice(i, i + 2);
      i += 2;
    } else if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      if (end < 0) return null;
      out += " ";
      i = end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** Index just past the string starting at `start`, or -1 when it never closes. */
function stringEnd(css: string, start: number): number {
  const quote = css[start];
  for (let i = start + 1; i < css.length; i++) {
    if (css[i] === "\\") i++;
    else if (css[i] === quote) return i + 1;
    else if (css[i] === "\n") return -1;
  }
  return -1;
}

/** Index just past the block or statement starting at `start` (depth 0 there), or -1 when unbalanced. */
function statementEnd(css: string, start: number): number {
  let depth = 0;
  for (let i = start; i < css.length; i++) {
    const ch = css[i];
    if (ch === '"' || ch === "'") {
      const end = stringEnd(css, i);
      if (end < 0) return -1;
      i = end - 1;
    } else if (ch === "\\") i++;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth < 0) return -1;
      if (depth === 0) return i + 1;
    } else if (ch === ";" && depth === 0) return i + 1;
  }
  return depth === 0 ? css.length : -1;
}

/**
 * Split into top-level statements, filtering at-rules (recursively inside the
 * allowed group rules). Null when the braces don't balance.
 */
function filterStatements(css: string): { scoped: string; hoisted: string } | null {
  let scoped = "";
  let hoisted = "";
  let i = 0;
  while (i < css.length) {
    if (/\s/.test(css[i])) {
      i++;
      continue;
    }
    const end = statementEnd(css, i);
    if (end < 0) return null;
    const statement = css.slice(i, end);
    i = end;
    const at = /^@([-\w]+)/.exec(statement);
    if (!at) {
      scoped += statement + "\n";
      continue;
    }
    const name = at[1].toLowerCase();
    if (!ALLOWED_AT_RULES.has(name)) continue;
    if (HOISTED_AT_RULES.has(name)) {
      hoisted += statement + "\n";
      continue;
    }
    // A group rule: filter its body by the same rules.
    const open = statement.indexOf("{");
    if (open < 0 || !statement.endsWith("}")) continue;
    const inner = filterStatements(statement.slice(open + 1, -1));
    if (!inner) return null;
    scoped += `${statement.slice(0, open)}{\n${inner.scoped}}\n`;
    hoisted += inner.hoisted;
  }
  return { scoped, hoisted };
}

/**
 * `css` confined to the elements matched by `scope` (a selector), ready to be
 * the text of a `<style>` element. "" when there is nothing usable.
 */
export function scopeUserCss(css: string, scope: string): string {
  const stripped = stripComments(css);
  if (stripped === null) return "";
  const filtered = filterStatements(stripped);
  if (!filtered) return "";
  const { scoped, hoisted } = filtered;
  if (!scoped.trim() && !hoisted.trim()) return "";
  const body = `${hoisted}@scope (${scope}) {\n${scoped}}\n`;
  return body.replace(/</g, "\\3c ");
}
