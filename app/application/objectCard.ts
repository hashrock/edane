/**
 * Object-card GEOMETRY: the single source of truth for how an expanded object
 * node's card is sized and where its title / separator / field rows sit.
 *
 * Both the layout measurement (nodeUtils.flattenToNodes) and the canvas draw
 * (MindmapEditor / MindmapViewer) read from here, so the card box and its
 * contents can never drift apart — the same contract measureModelNode gives
 * plain nodes.
 *
 * All vertical positions are relative to the card's TOP edge; the flat-node
 * layer converts them to world coordinates once the card's centre is known.
 */

import type { MindMapModel } from "../domain/model";
import { measureNodeBox, LINE_HEIGHT } from "../lib/measureText";
import { imageDisplaySize } from "../lib/imageCache";
import { markdownTitle } from "./markdownCard";
import {
  parseField,
  inferValueKind,
  formatFieldValue,
  type ValueKind,
} from "./objectField";

/** Minimum card content width (px) so near-empty cards still read as cards. */
export const CARD_MIN_CONTENT_W = 180;
/** Padding above the title block (from the card's top edge). */
export const CARD_TITLE_TOP = 8;
/** Padding between the title block and the separator line. */
export const CARD_TITLE_BOTTOM = 6;
/** Padding between the separator line and the first field row. */
export const CARD_ROWS_TOP = 6;
/** Padding below the last row (or the hint) to the card's bottom edge. */
export const CARD_BOTTOM = 8;
/** Minimum field-row height (px). */
export const ROW_MIN_H = 26;
/** Vertical padding inside a field row. */
export const ROW_V_PAD = 8;
/** Key-label font size (smaller than the 14px value text). */
export const KEY_FONT_SIZE = 12;
/** Gap between the key column and the value column. */
export const KEY_GAP = 12;
/** Key column width cap so a long key can't push every value off-card. */
export const KEY_COL_MAX = 140;
/** Image-value thumbnail bounds (kept small — the card is a summary view). */
export const ROW_THUMB_MAX_W = 160;
export const ROW_THUMB_MAX_H = 72;
/** Width reserved at a row's right edge for the hidden-children pill. */
export const ROW_BADGE_W = 26;
/** Height of the "add children" hint shown inside an empty card. */
export const CARD_HINT_H = 22;
export const CARD_HINT_TEXT = "子ノードを追加するとフィールドになります";

export interface CardRowGeom {
  /** The row's node id (== the model child's id). */
  id: string;
  /** Index among the card's children. */
  index: number;
  key: string | null;
  /** Formatted display string for the value (raw text stays on the node). */
  display: string;
  kind: ValueKind;
  /** Row top relative to the card's top edge (px). */
  top: number;
  height: number;
  /** Scaled thumbnail size (kind "image" / image-type rows only). */
  thumbW?: number;
  thumbH?: number;
}

export interface ObjectCardGeom {
  /** Content width (px); the node box adds NODE_PADDING on both sides. */
  width: number;
  /** Full card box height (px). */
  height: number;
  /** Title block centre, relative to the card's top edge. */
  titleCenterY: number;
  /** Separator line y, relative to the card's top edge. */
  sepY: number;
  /** Shared key column width across all rows (0 when no row has a key). */
  keyColW: number;
  rows: CardRowGeom[];
}

/** Live edit override: while `id` is being edited, measure with `text`. */
export interface EditingOverride {
  id: string;
  text: string;
}

interface RowCalc {
  key: string | null;
  display: string;
  kind: ValueKind;
  height: number;
  rawW: number;
  dispW: number;
  keyW: number;
  hasHiddenChildren: boolean;
  thumbW?: number;
  thumbH?: number;
}

function calcRow(child: MindMapModel, raw: string): RowCalc {
  const type = child.type ?? "text";

  if (type === "image") {
    const d = imageDisplaySize(raw);
    const scale = Math.min(1, ROW_THUMB_MAX_W / d.w, ROW_THUMB_MAX_H / d.h);
    const thumbW = Math.max(1, d.w * scale);
    const thumbH = Math.max(1, d.h * scale);
    return {
      key: null,
      display: "",
      kind: "image",
      height: thumbH + ROW_V_PAD,
      rawW: thumbW,
      dispW: thumbW,
      keyW: 0,
      hasHiddenChildren: child.children.length > 0,
      thumbW,
      thumbH,
    };
  }

  let key: string | null = null;
  let display: string;
  let kind: ValueKind;
  if (type === "link") {
    display = child.linkTitle || raw;
    kind = "url";
  } else if (type === "markdown") {
    display = markdownTitle(raw);
    kind = "text";
  } else {
    const parsed = parseField(raw);
    key = parsed.key;
    kind = inferValueKind(parsed.value);
    display =
      kind === "number"
        ? formatFieldValue(parsed.value, child.numFormat, child.decimals)
        : parsed.value;
  }

  // The row must fit BOTH renderings: the two-column display and the raw
  // `key: value` text shown while the row is being edited.
  const rawBox = measureNodeBox(raw);
  const dispBox = measureNodeBox(display === "" ? "empty" : display);
  const keyW = key
    ? Math.min(measureNodeBox(key, { fontSize: KEY_FONT_SIZE }).width, KEY_COL_MAX)
    : 0;
  return {
    key,
    display,
    kind,
    height: Math.max(ROW_MIN_H, rawBox.lineCount * LINE_HEIGHT + ROW_V_PAD),
    rawW: rawBox.width,
    dispW: dispBox.width,
    keyW,
    hasHiddenChildren: child.children.length > 0,
  };
}

/**
 * Compute the card geometry for an expanded object node. `editing` supplies
 * the live text buffer for the title or a row while it is being edited (the
 * model lags one keystroke behind during IME composition).
 */
export function objectCardGeom(
  node: MindMapModel,
  editing?: EditingOverride
): ObjectCardGeom {
  const titleRaw = editing?.id === node.id ? editing.text : node.text;
  const titleBox = measureNodeBox(titleRaw, { bold: true });
  const titleH = titleBox.lineCount * LINE_HEIGHT;
  const titleCenterY = CARD_TITLE_TOP + titleH / 2;
  const sepY = CARD_TITLE_TOP + titleH + CARD_TITLE_BOTTOM;

  const calcs = node.children.map((child) =>
    calcRow(child, editing?.id === child.id ? editing.text : child.text)
  );
  const keyColW = calcs.reduce((w, c) => Math.max(w, c.keyW), 0);

  let width = Math.max(CARD_MIN_CONTENT_W, titleBox.width);
  const rows: CardRowGeom[] = [];
  let top = sepY + CARD_ROWS_TOP;
  calcs.forEach((c, i) => {
    const colsW = (c.key !== null ? keyColW + KEY_GAP : 0) + c.dispW;
    width = Math.max(
      width,
      Math.max(c.rawW, colsW) + (c.hasHiddenChildren ? ROW_BADGE_W : 0)
    );
    rows.push({
      id: node.children[i].id,
      index: i,
      key: c.key,
      display: c.display,
      kind: c.kind,
      top,
      height: c.height,
      thumbW: c.thumbW,
      thumbH: c.thumbH,
    });
    top += c.height;
  });
  if (rows.length === 0) {
    top += CARD_HINT_H;
    // The hint line must fit inside the card too.
    width = Math.max(
      width,
      measureNodeBox(CARD_HINT_TEXT, { fontSize: 11 }).width
    );
  }

  return { width, height: top + CARD_BOTTOM, titleCenterY, sepY, keyColW, rows };
}
