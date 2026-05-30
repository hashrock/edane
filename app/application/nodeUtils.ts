/**
 * Application layer: bridge between domain model and rendering nodes.
 */

import type { MindMapModel } from "../domain/model";
import type { MindMapNode } from "../types/MindMap";

/** Flatten model tree to MindMapNode[] for layout/rendering */
export function flattenToNodes(model: MindMapModel): MindMapNode[] {
  const nodes: MindMapNode[] = [];
  function walk(m: MindMapModel) {
    nodes.push({
      id: m.id,
      text: m.text,
      x: 0,
      y: 0,
      children: m.children.map((c) => c.id),
    });
    for (const child of m.children) walk(child);
  }
  walk(model);
  return nodes;
}
