/**
 * Application layer: content serialization and format conversion.
 * Depends on domain/model only.
 */

import type { MindMapModel } from "../domain/model";
import { generateId } from "../domain/model";

/** Convert indented plain text (legacy format) to MindMapModel */
export function textToModel(title: string, content: string): MindMapModel {
  const root: MindMapModel = {
    id: generateId(),
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
      id: generateId(),
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
 * Note content is external data (it comes from the DB / `PUT /api/notes/:id`),
 * but the whole domain layer assumes IDs uniquely identify a node —
 * `findNode` / `findParentAndIndex` / `removeNode` all act on the *first*
 * match, so a duplicated id silently makes edits, deletes and publish/upload
 * targeting hit (or leave behind) the wrong node. JSON already guarantees a
 * tree (no shared references → no shared child, no cycles), so the one hazard
 * it can carry is a duplicated — or missing / malformed — id.
 *
 * This walks the value depth-first, dropping malformed children (anything that
 * is not a `{text, children[]}` shape) and reassigning any id that is missing,
 * non-string or already seen, so the returned model is a genuine unique-id
 * tree. Returns null when the value isn't a usable node at all (caller then
 * falls back to the legacy text parser).
 */
function normalizeTree(
  value: unknown,
  seen: Set<string>
): MindMapModel | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.text !== "string" || !Array.isArray(v.children)) return null;

  let id = typeof v.id === "string" ? v.id : "";
  if (id === "" || seen.has(id)) id = generateId();
  seen.add(id);

  const node: MindMapModel = { id, text: v.text, children: [] };

  // Preserve the known optional fields, guarding each by type.
  if (v.collapsed === true) node.collapsed = true;
  if (v.type === "image" || v.type === "link") node.type = v.type;
  if (typeof v.fontSize === "number") node.fontSize = v.fontSize;
  if (v.bold === true) node.bold = true;
  if (typeof v.linkTitle === "string") node.linkTitle = v.linkTitle;
  if (typeof v.favicon === "string") node.favicon = v.favicon;

  for (const child of v.children) {
    const normalized = normalizeTree(child, seen);
    if (normalized) node.children.push(normalized);
  }
  return node;
}

/** Parse content string: try JSON first, fall back to legacy text */
export function parseContent(
  content: string | undefined,
  title: string | undefined
): MindMapModel {
  if (!content) {
    return createDefaultModel(title);
  }

  try {
    const parsed = JSON.parse(content);
    // Validate the *whole* tree and repair duplicate/malformed ids, rather than
    // trusting a shallow shape check on the root alone.
    const normalized = normalizeTree(parsed, new Set());
    if (normalized) return normalized;
  } catch {
    // Not JSON, try legacy format
  }

  return textToModel(title || "Mindmap", content);
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

export function createDefaultModel(title?: string): MindMapModel {
  return {
    id: generateId(),
    text: title || defaultNoteTitle(),
    children: [
      {
        id: generateId(),
        text: "使い方",
        children: [
          {
            id: generateId(),
            text: "ノードをクリックして編集",
            children: [],
          },
          {
            id: generateId(),
            text: "Enterで兄弟ノード追加",
            children: [],
          },
          { id: generateId(), text: "Tabでインデント", children: [] },
        ],
      },
      {
        id: generateId(),
        text: "特徴",
        children: [
          {
            id: generateId(),
            text: "リアルタイムプレビュー",
            children: [],
          },
          { id: generateId(), text: "JSONベース", children: [] },
          { id: generateId(), text: "シンプル", children: [] },
        ],
      },
    ],
  };
}
