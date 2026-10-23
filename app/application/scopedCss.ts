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
 *    no unscoping), at every depth — also inside style rules (CSS nesting) —
 *    and an escaped at-keyword is dropped rather than read as a style rule;
 *  - `@keyframes` are hoisted out of the scope, where they are valid, and their
 *    names get a prefix (rewritten in `animation` declarations), since keyframe
 *    names are global and would otherwise redefine the app's own animations;
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

/** Prefix for the author's keyframe names: they are global, so they must not collide with the app's own. */
const KEYFRAMES_PREFIX = "wpu-";
const ANIMATION_DECLARATION = /^((?:-webkit-)?animation(?:-name)?\s*:)([^]*)$/i;

/** The keyframe names `css` defines (only plain identifiers; anything else is dropped). */
function keyframeNames(css: string): Set<string> {
  return new Set([...css.matchAll(/@(?:-webkit-)?keyframes\s+([-\w]+)/gi)].map((m) => m[1]));
}

/** An `animation` / `animation-name` declaration with the author's keyframe names prefixed. */
function renameAnimation(statement: string, names: Set<string>): string {
  const decl = ANIMATION_DECLARATION.exec(statement);
  if (!decl) return statement;
  const value = decl[2].replace(/(^|[\s,])([-\w]+)(?=$|[\s,;!])/g, (all, before: string, name: string) =>
    names.has(name) ? `${before}${KEYFRAMES_PREFIX}${name}` : all
  );
  return decl[1] + value;
}

type Filtered = { scoped: string; hoisted: string };

/**
 * Split into statements, filtering at-rules at every depth — inside the allowed
 * group rules and inside style rules too (CSS nesting puts at-rules there).
 * `inBlock`: the body of a style rule, whose whitespace and declarations are
 * kept as written. Null when the braces don't balance.
 */
function filterStatements(css: string, names: Set<string>, inBlock = false): Filtered | null {
  let scoped = "";
  let hoisted = "";
  let i = 0;
  const sep = inBlock ? "" : "\n";
  while (i < css.length) {
    if (/\s/.test(css[i])) {
      if (inBlock) scoped += css[i];
      i++;
      continue;
    }
    const end = statementEnd(css, i);
    if (end < 0) return null;
    const statement = css.slice(i, end);
    i = end;
    const open = statement.indexOf("{");
    const hasBlock = open >= 0 && statement.endsWith("}");
    if (!statement.startsWith("@")) {
      if (!hasBlock) {
        scoped += (inBlock ? renameAnimation(statement, names) : statement) + sep;
        continue;
      }
      // A style rule: its body may nest rules and at-rules.
      const inner = filterStatements(statement.slice(open + 1, -1), names, true);
      if (!inner) return null;
      scoped += `${statement.slice(0, open)}{${inner.scoped}}${sep}`;
      hoisted += inner.hoisted;
      continue;
    }
    // The at-keyword must be a plain identifier: an escaped one (`@\73 cope`)
    // is decoded by the browser, so it would slip past the allowlist.
    const at = /^@([-\w]+)(?![-\w\\])/.exec(statement);
    if (!at) continue;
    const name = at[1].toLowerCase();
    if (!ALLOWED_AT_RULES.has(name) || !hasBlock) continue;
    const hoist = HOISTED_AT_RULES.has(name);
    const inner = filterStatements(statement.slice(open + 1, -1), names, inBlock && !hoist);
    if (!inner) return null;
    if (hoist) {
      const prelude = /^@[-\w]+\s+([-\w]+)\s*$/.exec(statement.slice(0, open));
      if (!prelude) continue;
      hoisted += `@${at[1]} ${KEYFRAMES_PREFIX}${prelude[1]} {\n${inner.scoped}}\n${inner.hoisted}`;
      continue;
    }
    // A group rule: its body is filtered by the same rules.
    scoped += `${statement.slice(0, open)}{\n${inner.scoped}}${sep}`;
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
  const filtered = filterStatements(stripped, keyframeNames(stripped));
  if (!filtered) return "";
  const { scoped, hoisted } = filtered;
  if (!scoped.trim() && !hoisted.trim()) return "";
  const body = `${hoisted}@scope (${scope}) {\n${scoped}}\n`;
  return body.replace(/</g, "\\3c ");
}
