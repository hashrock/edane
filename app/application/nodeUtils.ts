/**
 * Application layer: bridge between domain model and rendering nodes.
 */

import type { MindMapModel, NodeType } from "../domain/model";
import { measureNodeBox, NODE_PADDING, nodeBoxWidth, nodeBoxHeight } from "../lib/measureText";
import { markdownTitle } from "./markdownCard";
import { objectCardGeom } from "./objectCard";
import type { ValueKind } from "./objectField";
import { imageDisplaySize, IMAGE_V_PAD } from "../lib/imageCache";

/**
 * Box sizing (nodeBoxWidth/nodeBoxHeight/NODE_PADDING) lives in lib/measureText
 * — it's pure geometry with no domain dependency, shared by lib/viewport too.
 * Re-exported here so existing application/component call sites are unaffected.
 */
export { NODE_PADDING, nodeBoxWidth, nodeBoxHeight };

/** Extra card width (px) for a markdown node: doc glyph + line-count badge. */
export const MD_CARD_LEAD = 24;
export const MD_CARD_BADGE = 34;

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
  /** Expanded object node: card offsets (relative to the box CENTRE y). */
  card?: { titleOffsetY: number; sepOffsetY: number; keyColW: number };
  /** Field row rendered inside an object card (positioned after tree layout). */
  cardRow?: {
    cardId: string;
    /** Index among the card's children (drop targets need the slot). */
    index: number;
    /** Row top relative to the card's TOP edge (px). */
    top: number;
    key: string | null;
    display: string;
    kind: ValueKind;
    keyColW: number;
    thumbW?: number;
    thumbH?: number;
  };
}

/** Rendered favicon size (px) + gap before the link title. */
export const FAVICON_SIZE = 16;
export const FAVICON_GAP = 6;

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
  if (m.type === "object" && !m.collapsed) {
    // An expanded object node keeps its CARD shape even while its title is
    // being edited (the live buffer overrides the title measurement only).
    // A collapsed one falls through to plain title-text sizing.
    const geom = objectCardGeom(
      m,
      editingText != null ? { id: m.id, text: editingText } : undefined
    );
    return { width: geom.width, height: geom.height };
  }
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
    // Shown as a COMPACT single-line card (doc glyph + title + line-count
    // badge); the full document renders in the HTML side panel on demand. The
    // box measures the (clipped) title plus fixed room for the glyph and badge.
    const box = measureNodeBox(markdownTitle(m.text), { fontSize: m.fontSize });
    return { width: box.width + MD_CARD_LEAD + MD_CARD_BADGE, height: box.height };
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

    if (type === "object" && !collapsed) {
      // Expanded object node: one card node (a layout LEAF — its flat
      // `children` stay empty so the tree layout doesn't position the rows)
      // plus one row node per direct child. Row world positions are derived
      // from the card box after layout (see layoutObjectRows). Grandchildren
      // are hidden inside the card, mirroring getFlatOrder.
      const override =
        editing != null &&
        (editing.id === m.id || m.children.some((c) => c.id === editing.id))
          ? editing
          : undefined;
      const geom = objectCardGeom(m, override);
      nodes.push({
        id: m.id,
        text: m.text,
        x: 0,
        y: 0,
        children: [],
        width: geom.width,
        height: geom.height,
        collapsed: false,
        childCount: m.children.length,
        type,
        fontSize: m.fontSize,
        bold: m.bold,
        linkTitle: m.linkTitle,
        favicon: m.favicon,
        card: {
          titleOffsetY: geom.titleCenterY - geom.height / 2,
          sepOffsetY: geom.sepY - geom.height / 2,
          keyColW: geom.keyColW,
        },
      });
      m.children.forEach((child, i) => {
        const row = geom.rows[i];
        nodes.push({
          id: child.id,
          text: child.text,
          x: 0,
          y: 0,
          children: [],
          // The hit box spans the card's width so the whole line activates.
          width: geom.width,
          height: row.height,
          collapsed: false,
          childCount: child.children.length,
          type: child.type ?? "text",
          // Rows render at the card's fixed 14px rhythm; per-node font
          // styling stays on the model and reappears outside the card.
          linkTitle: child.linkTitle,
          favicon: child.favicon,
          cardRow: {
            cardId: m.id,
            index: i,
            top: row.top,
            key: row.key,
            display: row.display,
            kind: row.kind,
            keyColW: geom.keyColW,
            thumbW: row.thumbW,
            thumbH: row.thumbH,
          },
        });
      });
      return;
    }

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

/**
 * Assign world positions to object-card field rows. Rows are layout leaves
 * (unreachable from the root through flat `children`), so the tree layout
 * leaves them at 0,0 — this pass anchors each row inside its card's box.
 * Call it right after layoutMindMap wherever flattenToNodes output is drawn.
 */
export function layoutObjectRows(nodes: MindMapNode[]): void {
  let hasRows = false;
  for (const n of nodes) {
    if (n.cardRow) {
      hasRows = true;
      break;
    }
  }
  if (!hasRows) return;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    const r = n.cardRow;
    if (!r) continue;
    const card = byId.get(r.cardId);
    if (!card) continue;
    n.x = card.x;
    n.y = card.y - nodeBoxHeight(card.height) / 2 + r.top + n.height / 2;
  }
}
