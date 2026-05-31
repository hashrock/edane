/**
 * Application layer: bridge between domain model and rendering nodes.
 */

import type { MindMapModel, NodeType } from "../domain/model";
import type { MindMapNode } from "../types/MindMap";
import { measureNodeBox } from "../lib/measureText";
import { imageDisplaySize, IMAGE_V_PAD } from "../lib/imageCache";

/** Rendered favicon size (px) + gap before the link title. */
export const FAVICON_SIZE = 16;
export const FAVICON_GAP = 6;

/** The node currently being edited (rendered as text regardless of its kind). */
export interface EditingNode {
  id: string;
  text: string;
}

/**
 * Flatten model tree to MindMapNode[] for layout/rendering.
 *
 * Descendants of a collapsed node are omitted (the collapsed node itself stays,
 * reporting its hidden child count). Each node carries its measured box size so
 * the layout can place variable-height nodes without overlap. Sizing is
 * kind-aware: image nodes use their (scaled) image size, text/link nodes use
 * pretext text measurement. The node currently being edited is always sized as
 * text from the live editing buffer, so it grows to fit the URL/label you type.
 */
export function flattenToNodes(
  model: MindMapModel,
  editing?: EditingNode
): MindMapNode[] {
  const nodes: MindMapNode[] = [];
  function walk(m: MindMapModel) {
    const collapsed = !!m.collapsed;
    const type: NodeType = m.type ?? "text";
    const isEditing = editing != null && editing.id === m.id;

    let width: number;
    let height: number;
    if (isEditing) {
      // The edited node is always rendered as plain text at the default font.
      const box = measureNodeBox(editing.text);
      width = box.width;
      height = box.height;
    } else if (type === "image") {
      const d = imageDisplaySize(m.text);
      width = d.w;
      height = d.h + IMAGE_V_PAD;
    } else if (type === "link") {
      // Links display their fetched title (falling back to the raw URL), with
      // room for the favicon when present.
      const display = m.linkTitle || m.text;
      const box = measureNodeBox(display, { fontSize: m.fontSize, bold: m.bold });
      width = box.width + (m.favicon ? FAVICON_SIZE + FAVICON_GAP : 0);
      height = box.height;
    } else {
      const box = measureNodeBox(m.text, { fontSize: m.fontSize, bold: m.bold });
      width = box.width;
      height = box.height;
    }

    nodes.push({
      id: m.id,
      text: m.text,
      x: 0,
      y: 0,
      // A collapsed node is laid out as a leaf (no visible children).
      children: collapsed ? [] : m.children.map((c) => c.id),
      width,
      height,
      collapsed,
      childCount: m.children.length,
      type,
      fontSize: m.fontSize,
      bold: m.bold,
      linkTitle: m.linkTitle,
      favicon: m.favicon,
    });
    if (collapsed) return;
    for (const child of m.children) walk(child);
  }
  walk(model);
  return nodes;
}
