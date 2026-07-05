/**
 * Application layer: Markdown detection and decomposition.
 *
 * Two pure helpers used by the paste flow:
 *  - {@link looksLikeMarkdown} — a cheap heuristic that decides whether a pasted
 *    string is worth offering the Markdown paste dialog for.
 *  - {@link markdownToModel} — "分解ペースト": turn a Markdown document into a
 *    node subtree, using heading levels and list indentation for hierarchy.
 *
 * Depends on domain/model only (no DOM / rendering).
 */

import type { MindMapModel } from "../domain/model";
import { generateId } from "../domain/model";

const HEADING = /^(#{1,6})\s+(.*)$/;
const UNORDERED = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)\d+[.)]\s+(.*)$/;
const BLOCKQUOTE = /^\s*>\s?(.*)$/;
const HR = /^\s*([-*_])\1{2,}\s*$/;
const FENCE = /^\s*(```|~~~)/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const INLINE_LINK = /\[[^\]]+\]\([^)]+\)/;
const INLINE_BOLD = /(\*\*|__)[^\s](?:.*?[^\s])?\1/;

/**
 * Heuristic Markdown detection. Returns true when at least one distinctive
 * Markdown construct is present (heading, list, blockquote, fenced code, table,
 * horizontal rule, inline link or bold). Deliberately conservative so that
 * plain prose, bare URLs and single indented lines don't trigger the dialog.
 */
export function looksLikeMarkdown(text: string): boolean {
  if (!text || !text.trim()) return false;
  const lineTests = [HEADING, UNORDERED, ORDERED, HR, FENCE, TABLE_ROW];
  for (const line of text.split("\n")) {
    if (/^\s*>\s+\S/.test(line)) return true;
    for (const re of lineTests) if (re.test(line) && line.trim() !== "") return true;
  }
  if (INLINE_LINK.test(text)) return true;
  if (INLINE_BOLD.test(text)) return true;
  return false;
}

/** Strip the most common inline Markdown decorations for readable node text. */
export function stripInline(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // [text](url) → text
    .replace(/`([^`]+)`/g, "$1") // `code` → code
    .replace(/(\*\*|__)(.+?)\1/g, "$2") // **bold** → bold
    .replace(/(^|[^*_])[*_]([^*_\s][^*_]*?)[*_](?=[^*_]|$)/g, "$1$2") // *em* → em
    .trim();
}

/**
 * Decompose a Markdown document into a node subtree.
 *
 * Returns a root whose `children` are the top-level nodes (callers paste the
 * children, mirroring {@link textToModel}). Hierarchy is derived from:
 *  - heading level (`#`..`######`) — an `h(n)` nests under the nearest heading
 *    of a lower level;
 *  - list indentation — bullets/numbers nest under the current heading and
 *    under one another by their leading whitespace;
 *  - fenced code blocks — collapsed into a single verbatim node.
 * Blank lines, horizontal rules and code fences themselves are dropped.
 */
export function markdownToModel(md: string): MindMapModel {
  const root: MindMapModel = { id: generateId(), text: "", children: [] };
  const stack: { node: MindMapModel; depth: number }[] = [
    { node: root, depth: -1 },
  ];

  // Depth at which content directly under the current heading sits. Content
  // before any heading lives at the top level (depth 0).
  let contentDepth = 0;

  const push = (depth: number, text: string) => {
    const node: MindMapModel = { id: generateId(), text, children: [] };
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) {
      stack.pop();
    }
    stack[stack.length - 1].node.children.push(node);
    stack.push({ node, depth });
  };

  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code block: gather everything up to the closing fence into one
    // verbatim node so code keeps its own line breaks and markers.
    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[1];
      const lang = line.trim().slice(marker.length).trim();
      const body: string[] = [];
      i++;
      for (; i < lines.length; i++) {
        if (lines[i].trim().startsWith(marker)) break;
        body.push(lines[i]);
      }
      const label = lang ? `${lang}:\n` : "";
      const code = body.join("\n");
      if (code.trim() !== "" || label) push(contentDepth, `${label}${code}`);
      continue;
    }

    if (line.trim() === "") continue;
    if (HR.test(line)) continue;

    const heading = line.match(HEADING);
    if (heading) {
      const level = heading[1].length; // 1..6
      push(level - 1, stripInline(heading[2]) || "見出し");
      contentDepth = level;
      continue;
    }

    const list = line.match(UNORDERED) || line.match(ORDERED);
    if (list) {
      const indent = list[1].replace(/\t/g, "  ").length;
      const depth = contentDepth + Math.floor(indent / 2);
      push(depth, stripInline(list[2]));
      continue;
    }

    const quote = line.match(BLOCKQUOTE);
    if (quote) {
      push(contentDepth, stripInline(quote[1]));
      continue;
    }

    // Plain paragraph / table / other line: content under the current heading.
    push(contentDepth, stripInline(line));
  }

  return root;
}

/** Render a single node's text as one Markdown list-item body. */
function nodeToMarkdownText(node: MindMapModel): string {
  const type = node.type ?? "text";
  if (type === "image") return `![](${node.text})`;
  if (type === "link") {
    const label = node.linkTitle?.trim() || node.text;
    return `[${label}](${node.text})`;
  }
  // A markdown node holds a raw blob; collapse newlines so it stays on the
  // bullet line (a full re-embed would break the outline's list structure).
  if (type === "markdown") return node.text.replace(/\n+/g, " ").trim();
  const text = node.text;
  return node.bold && text.trim() !== "" ? `**${text}**` : text;
}

/**
 * Serialize a node and its descendants as a nested Markdown bullet list — the
 * inverse direction of {@link markdownToModel}, used by "Markdownとしてコピー".
 * The given node is the top-level item; children nest two spaces deeper per
 * level. Text nodes honour their `bold` flag; image/link nodes become their
 * Markdown image/link syntax.
 */
export function modelToMarkdown(node: MindMapModel): string {
  const lines: string[] = [];
  const walk = (n: MindMapModel, depth: number) => {
    lines.push(`${"  ".repeat(depth)}- ${nodeToMarkdownText(n)}`);
    for (const child of n.children) walk(child, depth + 1);
  };
  walk(node, 0);
  return lines.join("\n");
}
