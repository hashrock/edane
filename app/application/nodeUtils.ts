/**
 * Application layer: bridge between domain model and rendering nodes.
 */

import type { MindMapModel } from "../domain/model";
import type { MindMapNode } from "../types/MindMap";
import { measureNodeBox } from "../lib/measureText";

/**
 * Flatten model tree to MindMapNode[] for layout/rendering.
 *
 * Descendants of a collapsed node are omitted (the collapsed node itself stays,
 * reporting its hidden child count). Each node carries its measured box size so
 * the layout can place variable-height (multi-line) nodes without overlap.
 */
export function flattenToNodes(model: MindMapModel): MindMapNode[] {
  const nodes: MindMapNode[] = [];
  function walk(m: MindMapModel) {
    const collapsed = !!m.collapsed;
    const box = measureNodeBox(m.text);
    nodes.push({
      id: m.id,
      text: m.text,
      x: 0,
      y: 0,
      // A collapsed node is laid out as a leaf (no visible children).
      children: collapsed ? [] : m.children.map((c) => c.id),
      width: box.width,
      height: box.height,
      collapsed,
      childCount: m.children.length,
    });
    if (collapsed) return;
    for (const child of m.children) walk(child);
  }
  walk(model);
  return nodes;
}
