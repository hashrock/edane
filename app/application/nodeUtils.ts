/**
 * Application layer: bridge between domain model and rendering nodes.
 */

import type { MindMapModel, NodeType } from "../domain/model";
import { measureNodeBox, BOX_V_PAD, MIN_BOX_HEIGHT } from "../lib/measureText";
import { layoutMarkdown } from "./markdownLayout";
import { imageDisplaySize, IMAGE_V_PAD } from "../lib/imageCache";

/** Flat node for rendering (computed from domain model via layout). */
export interface MindMapNode {
  id: string;
  text: string;
  x: number;
  y: number;
  children: string[];
  /** Node kind (text/image/link). */
  type: NodeType;
  /** Measured box width (px); filled in by layout. */
  width: number;
  /** Measured box height (px), incl. multi-line text; filled in by layout. */
  height: number;
  /** Whether this node is collapsed (its descendants are hidden). */
  collapsed: boolean;
  /** Number of direct children in the model (even when collapsed). */
  childCount: number;
  /** Font size in px (text/link nodes); falls back to the default when absent. */
  fontSize?: number;
  /** Bold text. */
  bold?: boolean;
  /** Link nodes: fetched page title (display text). */
  linkTitle?: string;
  /** Link nodes: favicon URL. */
  favicon?: string;
}

/** Rendered favicon size (px) + gap before the link title. */
export const FAVICON_SIZE = 16;
export const FAVICON_GAP = 6;

/** Horizontal padding between a node's box edge and its content (px). */
export const NODE_PADDING = 20;

/**
 * A markdown node holds a whole document in `text`; render only a bounded
 * preview so a large paste can't produce a giant unusable box. Caps both the
 * number of lines and each line's length, appending an ellipsis when clipped.
 * Both the layout measurement and the canvas draw read the same preview so the
 * box always matches what is shown.
 */
export function markdownPreview(text: string, maxLines = 14): string {
  const lines = text.replace(/\r/g, "").split("\n");
  const clipped = lines
    .slice(0, maxLines)
    .map((l) => (l.length > 80 ? l.slice(0, 80) + "…" : l));
  if (lines.length > maxLines) clipped.push("…");
  return clipped.join("\n");
}

/**
 * Visual box width for a measured text/content width: add horizontal padding,
 * then floor (roots a little wider). Keeps every node-box width derivation in
 * one place — the canvas draw and the drag-drop hit test must agree — so
 * neither ever re-implements per-kind sizing.
 */
export function nodeBoxWidth(measuredWidth: number, isRoot: boolean): number {
  return Math.max(measuredWidth + NODE_PADDING * 2, isRoot ? 100 : 80);
}

/** Visual box height for a measured content height (px), with the 32px floor. */
export function nodeBoxHeight(measuredHeight: number): number {
  return Math.max(32, measuredHeight);
}

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
  if (m.type === "markdown") {
    // Rendered as styled block-level Markdown; both the box and the canvas draw
    // read the same layout so they never drift. The vertical padding + height
    // floor reuse measureNodeBox's own box constants (below), matching how text
    // nodes are sized.
    const md = layoutMarkdown(m.text, m.fontSize);
    return { width: md.width, height: Math.max(MIN_BOX_HEIGHT, md.height + BOX_V_PAD) };
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
