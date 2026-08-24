/**
 * Application layer: bridge between domain model and rendering nodes.
 */

import { type MindMapModel, type NodeType, visibleChildrenOf } from "../domain/model";
import {
  measureNodeBox,
  NODE_PADDING,
  NODE_MAX_CONTENT_WIDTH,
  nodeBoxWidth,
  nodeBoxHeight,
} from "../lib/measureText";
import { assertNever } from "../lib/assertNever";
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
/**
 * Width the markdown card's title may occupy — the content cap minus the glyph
 * and badge columns. The card stays ONE line (the whole document is a panel
 * away), so the title is ellipsised at this width rather than wrapped; the
 * canvas draw sets the same width on its Konva.Text, so the measured box and
 * the ellipsis land together.
 */
export const MD_TITLE_MAX_W =
  NODE_MAX_CONTENT_WIDTH - MD_CARD_LEAD - MD_CARD_BADGE;

/** Rendered task-checkbox size (px) + gap before the node's content. */
export const CHECKBOX_SIZE = 14;
export const CHECKBOX_GAP = 8;

/**
 * Which kinds can carry a task checkbox — the ONE place that decides it, read
 * by the geometry below, both editors' rendering and every UI affordance that
 * offers the toggle.
 *
 * Only the kinds that paint a line of text beside the box qualify. An image
 * has no text line to sit next to; a markdown node is a compact card standing
 * in for a whole document (its tasks are inside it, not on it); an object node
 * is a card of `key: value` rows, and its rows are laid out by objectCardGeom,
 * which sizes the key/value columns and knows nothing of a checkbox column.
 *
 * Exhaustive over `NodeType` (`assertNever`), so a new kind has to answer this
 * question rather than silently inheriting an answer.
 */
export function supportsCheckbox(type: NodeType): boolean {
  switch (type) {
    case "text":
    case "link":
      return true;
    case "image":
    case "markdown":
    case "object":
      return false;
    default:
      return assertNever(type);
  }
}

/**
 * Width the checkbox takes out of a node's content column (0 when the node
 * isn't a task, or is a kind that shows no box). Like {@link FAVICON_SIZE}'s
 * column it is chrome drawn INSIDE the box, so the cap subtracts it and the
 * measurement adds it back — text wrapped without it would overflow the node
 * by exactly the checkbox.
 */
export function checkboxOffset(n: {
  type?: NodeType;
  checked?: boolean;
}): number {
  return n.checked !== undefined && supportsCheckbox(n.type ?? "text")
    ? CHECKBOX_SIZE + CHECKBOX_GAP
    : 0;
}

/**
 * Width cap for a node's own TEXT: the shared content cap minus whatever chrome
 * its kind draws alongside (a favicon column, the markdown card's glyph and
 * badge). Both the measurement below and the canvas draw/caret read it — via
 * `MindMapNode.contentMaxWidth` — so neither can wrap at a width the other
 * didn't size for.
 *
 * Exhaustive over `NodeType` (`assertNever`), so a new kind has to declare its
 * cap here instead of silently inheriting the full width.
 */
export function nodeContentMaxWidth(m: MindMapModel): number {
  const type: NodeType = m.type ?? "text";
  // The task checkbox is chrome on any kind that can have one, so it comes off
  // the cap here once instead of in each branch below.
  const cap = NODE_MAX_CONTENT_WIDTH - checkboxOffset(m);
  switch (type) {
    case "link":
      return cap - (m.favicon ? FAVICON_SIZE + FAVICON_GAP : 0);
    case "markdown":
      return MD_TITLE_MAX_W;
    case "image":
    case "text":
    case "object":
      return cap;
    default:
      return assertNever(type);
  }
}

/**
 * The string a node actually DRAWS — a link shows its fetched title and falls
 * back to the raw URL, every other kind shows its own `text`.
 *
 * Single authority for that fallback, read by BOTH sides that must agree on it:
 * {@link measureModelNode} (which sizes the box) and the canvas draw (which
 * builds the visual lines it paints, via lib/textGeometry's buildLineData).
 * When only one of the two knew about `linkTitle`, a link with a fetched title
 * was measured for the title but painted with the URL — the box and the text
 * inside it disagreed by however much longer the URL was.
 *
 * Takes the structural subset both `MindMapModel` and {@link MindMapNode}
 * satisfy, so neither side has to convert to call it. A markdown node is NOT
 * covered here: its card paints a derived, ellipsised title (see
 * {@link markdownTitle}) rather than a wrapped line block.
 */
export function nodeDisplayText(n: {
  type?: NodeType;
  text: string;
  linkTitle?: string;
}): string {
  return (n.type ?? "text") === "link" ? n.linkTitle || n.text : n.text;
}

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
  /**
   * Width this node's text was wrapped at (see {@link nodeContentMaxWidth}).
   * The draw/caret path re-derives the visual lines from the raw text, so it
   * must use the very cap the box was measured with.
   */
  contentMaxWidth: number;
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
  /** Task checkbox state (absent = not a task). See MindMapModel.checked. */
  checked?: boolean;
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
    /**
     * The row's value, pre-wrapped to the value column (see CardRowGeom).
     * Empty when the row has no value — the draw shows a placeholder instead.
     */
    displayLines: string[];
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
 * X offset from a node's box LEFT EDGE to where its text line starts: the box
 * padding plus every chrome column drawn ahead of the text (the task checkbox,
 * a link's favicon).
 *
 * Every path that positions text against the box goes through here — the
 * canvas draw, the caret and selection overlay, the click→caret mapping and
 * drag-select — so a new chrome column can't shift the painted text while
 * leaving the caret behind it.
 */
export function nodeTextOffsetX(n: {
  type?: NodeType;
  checked?: boolean;
  favicon?: string;
}): number {
  const isLink = (n.type ?? "text") === "link";
  return (
    NODE_PADDING +
    checkboxOffset(n) +
    (isLink && n.favicon ? FAVICON_SIZE + FAVICON_GAP : 0)
  );
}

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
 *  - text / collapsed object → its text.
 *
 * Every kind is bounded by NODE_MAX_CONTENT_WIDTH, each in the way that suits
 * it: text-like content soft-wraps, the markdown card ellipsises its one-line
 * title, and an image scales down (lib/imageCache). See the constant's doc.
 *
 * The kind switch below is exhaustive (`assertNever` in the default branch)
 * so that adding a `NodeType` member — same trick as `STORED_NODE_TYPE_SET`
 * in domain/model.ts — fails to compile here until this function decides how
 * the new kind sizes, instead of silently falling through to plain-text
 * measurement.
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
    const box = measureNodeBox(editingText, {
      fontSize: m.fontSize,
      bold: m.bold,
      maxWidth: nodeContentMaxWidth(m),
    });
    return { width: box.width + checkboxOffset(m), height: box.height };
  }
  const type: NodeType = m.type ?? "text";
  switch (type) {
    case "image": {
      const d = imageDisplaySize(m.text);
      return { width: d.w, height: d.h + IMAGE_V_PAD };
    }
    case "link": {
      const box = measureNodeBox(nodeDisplayText(m), {
        fontSize: m.fontSize,
        bold: m.bold,
        maxWidth: nodeContentMaxWidth(m),
      });
      return {
        width:
          box.width +
          checkboxOffset(m) +
          (m.favicon ? FAVICON_SIZE + FAVICON_GAP : 0),
        height: box.height,
      };
    }
    case "markdown": {
      // Shown as a COMPACT single-line card (doc glyph + title + line-count
      // badge); the full document renders in the HTML side panel on demand.
      // The box measures the (clipped) title plus fixed room for the glyph
      // and badge. The title never wraps — it is ellipsised at MD_TITLE_MAX_W,
      // so the card keeps its one-line shape whatever the document holds.
      const box = measureNodeBox(markdownTitle(m.text), {
        fontSize: m.fontSize,
        maxWidth: Infinity,
      });
      return {
        width:
          Math.min(box.width, MD_TITLE_MAX_W) + MD_CARD_LEAD + MD_CARD_BADGE,
        height: box.height,
      };
    }
    case "text":
    case "object": {
      const box = measureNodeBox(m.text, {
        fontSize: m.fontSize,
        bold: m.bold,
        maxWidth: nodeContentMaxWidth(m),
      });
      return { width: box.width + checkboxOffset(m), height: box.height };
    }
    default:
      return assertNever(type);
  }
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
    const vis = visibleChildrenOf(m);

    if (vis.kind === "leaves") {
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
        // The card's editable text is its title, which wraps at the full cap.
        contentMaxWidth: NODE_MAX_CONTENT_WIDTH,
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
          // A row that is being text-edited shows its raw `key: value` text,
          // which objectCardGeom also measured at the full cap.
          contentMaxWidth: NODE_MAX_CONTENT_WIDTH,
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
            displayLines: row.displayLines,
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
      contentMaxWidth: nodeContentMaxWidth(m),
      collapsed,
      childCount: m.children.length,
      type,
      fontSize: m.fontSize,
      bold: m.bold,
      linkTitle: m.linkTitle,
      favicon: m.favicon,
      checked: m.checked,
    });
    if (vis.kind === "none") return;
    for (const child of vis.children) walk(child);
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
