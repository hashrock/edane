/**
 * Application layer: content serialization and format conversion.
 * Depends on domain/model only.
 */

import type { MindMapModel } from "../domain/model";
import {
  ensureTopLevelNode,
  generateId,
  isStoredNodeType,
  type IdSource,
} from "../domain/model";
import { t } from "./i18n";

/** Convert indented plain text (legacy format) to MindMapModel */
export function textToModel(
  title: string,
  content: string,
  nextId: IdSource = generateId
): MindMapModel {
  const root: MindMapModel = {
    id: nextId(),
    text: title,
    children: [],
  };

  if (!content || content.trim() === "") return root;

  const lines = content.split("\n");
  const stack: { node: MindMapModel; depth: number }[] = [
    { node: root, depth: -1 },
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
    stack[stack.length - 1].node.children.push(newNode);
    stack.push({ node: newNode, depth });
  }

  return root;
}

/**
 * Validate and normalize an arbitrary parsed value into a well-formed
 * MindMapModel *tree with unique ids*.
 *
 * The value is untrusted external data — it comes from the DB / `PUT
 * /api/notes/:id`, or (via {@link "./branchClipboard".parseBranch}) from
 * whatever a paste event's clipboard happens to carry — but the whole domain
 * layer assumes IDs uniquely identify a node — `findNode` / `findParentAndIndex`
 * / `removeNode` all act on the *first* match, so a duplicated id silently
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
 * Parse content string: try JSON first, fall back to legacy text. The result
 * always has at least one top-level node (the root is the title, not a node —
 * see `topLevelNodes`), so the editor always has something to select.
 */
export function parseContent(
  content: string | undefined,
  title: string | undefined,
  nextId: IdSource = generateId
): MindMapModel {
  if (!content) {
    return createDefaultModel(title, nextId);
  }

  try {
    const parsed = JSON.parse(content);
    // Validate the *whole* tree and repair duplicate/malformed ids, rather than
    // trusting a shallow shape check on the root alone.
    const normalized = normalizeTree(parsed, new Set(), nextId);
    if (normalized) return ensureTopLevelNode(normalized, nextId);
  } catch {
    // Not JSON, try legacy format
  }

  return ensureTopLevelNode(
    textToModel(title || "Mindmap", content, nextId),
    nextId
  );
}

/** Convert MindMapModel to indented plain text */
export function modelToText(model: MindMapModel, depth = 0): string {
  const indent = "  ".repeat(depth);
  let result = `${indent}${model.text}`;
  for (const child of model.children) {
    result += "\n" + modelToText(child, depth + 1);
  }
  return result;
}

/** Serialize model for API storage */
export function serializeModel(model: MindMapModel): string {
  return JSON.stringify(model);
}

/** Default note title: "New Note" plus the current date (YYYY-MM-DD) */
export function defaultNoteTitle(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `New Note ${y}-${m}-${d}`;
}

/** Default note: one tree root with two children (the root is the title). */
export function createDefaultModel(
  title?: string,
  nextId: IdSource = generateId
): MindMapModel {
  return {
    id: nextId(),
    text: title || defaultNoteTitle(),
    children: [
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
