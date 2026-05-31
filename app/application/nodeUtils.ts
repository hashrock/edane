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
 * Measure a model node's render box (width × height in px).
 *
 * Single source of truth for node sizing: both the layout (flattenToNodes) and
 * the canvas draw read their box from here (the latter via the measured
 * width/height carried on each MindMapNode), so the two can never drift apart.
 *
 * Sizing is kind-aware and honors each node's font size / bold:
 *  - `editingText` given → sized as plain text from the live buffer, so an
 *    image/link node grows to fit the raw URL while a caret is active.
 *  - image → its (scaled) image display size.
 *  - link  → its fetched title (falling back to the URL) plus favicon room.
 *  - text  → its text.
 */
export function measureModelNode(
  m: MindMapModel,
  editingText?: string
): { width: number; height: number } {
  if (editingText != null) {
    const box = measureNodeBox(editingText, { fontSize: m.fontSize, bold: m.bold });
    return { width: box.width, height: box.height };
  }
  if ((m.type ?? "text") === "image") {
    const d = imageDisplaySize(m.text);
    return { width: d.w, height: d.h + IMAGE_V_PAD };
  }
  if (m.type === "link") {
    const display = m.linkTitle || m.text;
    const box = measureNodeBox(display, { fontSize: m.fontSize, bold: m.bold });
    return {
      width: box.width + (m.favicon ? FAVICON_SIZE + FAVICON_GAP : 0),
      height: box.height,
    };
  }
  const box = measureNodeBox(m.text, { fontSize: m.fontSize, bold: m.bold });
  return { width: box.width, height: box.height };
}

/**
 * Flatten model tree to MindMapNode[] for layout/rendering.
 *
 * Descendants of a collapsed node are omitted (the collapsed node itself stays,
 * reporting its hidden child count). Each node carries its measured box size
 * (see {@link measureModelNode}) so the layout can place variable-height nodes
 * without overlap.
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
    const { width, height } = measureModelNode(
      m,
      isEditing ? editing.text : undefined
    );

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
