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
    if (
      parsed &&
      typeof parsed.id === "string" &&
      typeof parsed.text === "string" &&
      Array.isArray(parsed.children)
    ) {
      return parsed as MindMapModel;
    }
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

export function createDefaultModel(title?: string): MindMapModel {
  return {
    id: generateId(),
    text: title || "Edane",
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
