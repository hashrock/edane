/**
 * Application layer: content serialization and format conversion.
 * Depends on domain/model only.
 *
 * Stored content formats (the note's `content` column), oldest first:
 *
 *  - **legacy text**: indented plain text, one node per line (pre-JSON).
 *  - **v1 JSON**: a single node `{ id, text, children, … }` — the classic
 *    single-root mind map, whose root text doubled as the note title (and
 *    which #135 briefly displayed as if its children were separate trees).
 *  - **v2 JSON** (current, see {@link CONTENT_FORMAT_VERSION}):
 *    `{ "version": 2, "roots": [node, …] }` — an honest forest. The title is
 *    NOT in the content: it is the note's own `title` column (sent alongside
 *    the content on every save), and {@link parseContent} joins the two.
 *
 * Reading accepts all three and always yields a `MindMapDocument`; writing
 * ({@link serializeDocument}) always emits v2. That is the whole migration:
 * a note is upgraded the first time it is saved after being opened, and
 * nothing needs to rewrite stored (possibly encrypted) rows in place.
 *
 * Older content migrates as a SINGLE root: the v1 root node (or, for legacy
 * text, a node carrying the title) becomes `roots[0]` and keeps every child
 * under it. Existing notes therefore keep the one-tree shape they were
 * written in; extra trees appear only when the user adds a root.
 */

import type { IdSource, MindMapDocument, MindMapModel } from "../domain/model";
import { ensureRoot, generateId, isStoredNodeType } from "../domain/model";
import { t } from "./i18n";

/** Format tag written by {@link serializeDocument}. */
export const CONTENT_FORMAT_VERSION = 2;

/** Convert indented plain text (one node per line) into a forest. */
export function textToNodes(
  content: string,
  nextId: IdSource = generateId
): MindMapModel[] {
  const roots: MindMapModel[] = [];
  if (!content || content.trim() === "") return roots;

  const lines = content.split("\n");
  const stack: { children: MindMapModel[]; depth: number }[] = [
    { children: roots, depth: -1 },
  ];

  for (const line of lines) {
    if (line.trim() === "") continue;
    const depth = line.search(/\S/);
    const text = line.trim();
    const newNode: MindMapModel = {
      id: nextId(),
      text,
      children: [],
    };

    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) {
      stack.pop();
    }
    stack[stack.length - 1].children.push(newNode);
    stack.push({ children: newNode.children, depth });
  }

  return roots;
}

/**
 * Convert indented plain text (legacy note content) to a document: one root
 * carrying the title, with the lines as its subtree (the shape this format
 * was written in).
 */
export function textToDocument(
  title: string,
  content: string,
  nextId: IdSource = generateId
): MindMapDocument {
  return {
    title,
    roots: [{ id: nextId(), text: title, children: textToNodes(content, nextId) }],
  };
}

/**
 * Validate and normalize an arbitrary parsed value into a well-formed
 * MindMapModel *tree with unique ids*.
 *
 * The value is untrusted external data — it comes from the DB / `PUT
 * /api/notes/:id`, or (via {@link "./branchClipboard".parseBranch}) from
 * whatever a paste event's clipboard happens to carry — but the whole domain
 * layer assumes IDs uniquely identify a node — `findNode` / `locateNode` /
 * `removeNode` all act on the *first* match, so a duplicated id silently
 * makes edits, deletes and publish/upload targeting hit (or leave behind) the
 * wrong node. JSON already guarantees a tree (no shared references → no shared
 * child, no cycles), so the one hazard it can carry is a duplicated — or
 * missing / malformed — id, or a field whose value falls outside its known
 * enum/type.
 *
 * This walks the value depth-first, dropping malformed children (anything that
 * is not a `{text, children[]}` shape), reassigning any id that is missing,
 * non-string or already seen, and dropping (rather than passing through) any
 * optional field whose value doesn't match its declared type, so the returned
 * model is a genuine well-formed, unique-id tree. Returns null when the value
 * isn't a usable node at all (caller then falls back to the legacy text
 * parser).
 */
export function normalizeTree(
  value: unknown,
  seen: Set<string>,
  nextId: IdSource = generateId
): MindMapModel | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.text !== "string" || !Array.isArray(v.children)) return null;

  let id = typeof v.id === "string" ? v.id : "";
  if (id === "" || seen.has(id)) id = nextId();
  seen.add(id);

  const node: MindMapModel = { id, text: v.text, children: [] };

  // Preserve the known optional fields, guarding each by type.
  if (v.collapsed === true) node.collapsed = true;
  if (isStoredNodeType(v.type)) node.type = v.type;
  if (typeof v.fontSize === "number") node.fontSize = v.fontSize;
  if (v.bold === true) node.bold = true;
  if (typeof v.linkTitle === "string") node.linkTitle = v.linkTitle;
  if (typeof v.favicon === "string") node.favicon = v.favicon;
  if (typeof v.checked === "boolean") node.checked = v.checked;
  if (
    v.position &&
    typeof v.position === "object" &&
    Number.isFinite((v.position as { x?: unknown }).x) &&
    Number.isFinite((v.position as { y?: unknown }).y)
  ) {
    const p = v.position as { x: number; y: number };
    node.position = { x: p.x, y: p.y };
  }

  for (const child of v.children) {
    const normalized = normalizeTree(child, seen, nextId);
    if (normalized) node.children.push(normalized);
  }
  return node;
}

/**
 * Normalize a parsed JSON value into a document, migrating older shapes:
 *  - v2 `{ roots: [...] }` → each root normalized ({@link normalizeTree}).
 *  - v1 node `{ text, children }` → the node becomes the document's single
 *    root, id and subtree intact (so node publications that point at it keep
 *    resolving); its `text` doubled as the title and is used as such when no
 *    title is given.
 * Ids are unique across the WHOLE document (one `seen` set spans the roots).
 * Returns null when the value is neither shape.
 */
export function normalizeDocument(
  value: unknown,
  title: string | undefined,
  nextId: IdSource = generateId
): MindMapDocument | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const seen = new Set<string>();

  if (Array.isArray(v.roots)) {
    const roots: MindMapModel[] = [];
    for (const r of v.roots) {
      const normalized = normalizeTree(r, seen, nextId);
      if (normalized) roots.push(normalized);
    }
    return { title: title ?? "", roots };
  }

  const legacyRoot = normalizeTree(value, seen, nextId);
  if (!legacyRoot) return null;
  // The v1 root's text also served as the title; the note's own title (when
  // known) wins so that a title edited through the notes API isn't undone by
  // stale content. The node itself stays as the single root.
  return { title: title || legacyRoot.text, roots: [legacyRoot] };
}

/**
 * Parse stored content: v2 JSON, v1 JSON or legacy indented text (in that
 * order of preference). The result always has at least one root (see
 * `MindMapDocument`), so the editor always has something to select.
 */
export function parseContent(
  content: string | undefined,
  title: string | undefined,
  nextId: IdSource = generateId
): MindMapDocument {
  if (!content) {
    return createDefaultDocument(title, nextId);
  }

  try {
    const parsed = JSON.parse(content);
    // Validate the *whole* forest and repair duplicate/malformed ids, rather
    // than trusting a shallow shape check.
    const normalized = normalizeDocument(parsed, title, nextId);
    if (normalized) return ensureRoot(normalized, nextId);
  } catch {
    // Not JSON, try legacy format
  }

  return ensureRoot(textToDocument(title || "Mindmap", content, nextId), nextId);
}

/** Convert a node subtree to indented plain text. */
export function modelToText(model: MindMapModel, depth = 0): string {
  const indent = "  ".repeat(depth);
  let result = `${indent}${model.text}`;
  for (const child of model.children) {
    result += "\n" + modelToText(child, depth + 1);
  }
  return result;
}

/** Convert the whole document (every tree, in order) to indented plain text. */
export function documentToText(doc: MindMapDocument): string {
  return doc.roots.map((r) => modelToText(r)).join("\n");
}

/**
 * Serialize the trees for the note's `content` column (v2). The title is
 * deliberately not included — it travels as the note's own `title` field.
 */
export function serializeDocument(doc: MindMapDocument): string {
  return JSON.stringify({
    version: CONTENT_FORMAT_VERSION,
    roots: doc.roots,
  });
}

/** Default note title: "New Note" plus the current date (YYYY-MM-DD) */
export function defaultNoteTitle(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `New Note ${y}-${m}-${d}`;
}

/** Default note: one tree root with two children. */
export function createDefaultDocument(
  title?: string,
  nextId: IdSource = generateId
): MindMapDocument {
  return {
    title: title || defaultNoteTitle(),
    roots: [
      {
        id: nextId(),
        text: t("sampleUsage"),
        children: [
          {
            id: nextId(),
            text: t("sampleClickToEdit"),
            children: [],
          },
          {
            id: nextId(),
            text: t("sampleEnter"),
            children: [],
          },
        ],
      },
    ],
  };
}
