/**
 * Object-card GEOMETRY: the single source of truth for how an expanded object
 * node's card is sized and where its title / separator / field rows sit.
 *
 * Both the layout measurement (nodeUtils.flattenToNodes) and the canvas draw
 * (MindmapEditor) read from here, so the card box and its contents can never
 * drift apart — the same contract measureModelNode gives plain nodes.
 *
 * All vertical positions are relative to the card's TOP edge; the flat-node
 * layer converts them to world coordinates once the card's centre is known.
 */

import type { MindMapModel } from "../domain/model";
import {
  measureNodeBox,
  wrapNodeText,
  LINE_HEIGHT,
  NODE_MAX_CONTENT_WIDTH,
} from "../lib/measureText";
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
/** Height of the "add field" affordance shown inside an empty card. */
export const CARD_HINT_H = 22;
/** Label of the empty-card "add field" button (also the width-reservation basis). */
export const ADD_FIELD_LABEL = "＋ フィールドを追加";
/** Font size of the "add field" button label. */
export const ADD_FIELD_FONT_SIZE = 11;
/** Horizontal padding inside the "add field" button (both sides combined). */
const ADD_FIELD_BTN_PAD = 20;

/**
 * Full width of the empty-card "add field" button. Single source for both the
 * width reservation in objectCardGeom and the drawn button, so they can't drift.
 */
export function addFieldButtonWidth(): number {
  return (
    measureNodeBox(ADD_FIELD_LABEL, { fontSize: ADD_FIELD_FONT_SIZE }).width +
    ADD_FIELD_BTN_PAD
  );
}

export interface CardRowGeom {
  /** The row's node id (== the model child's id). */
  id: string;
  /** Index among the card's children. */
  index: number;
  key: string | null;
  /** Formatted display string for the value (raw text stays on the node). */
  display: string;
  /**
   * `display` split into the visual lines the value column actually renders
   * (soft-wrapped to the room left by the key column and the badge). The draw
   * joins these back with "\n" so the row's height and its text agree.
   */
  displayLines: string[];
  kind: ValueKind;
  /** Row top relative to the card's top edge (px). */
  top: number;
  height: number;
  /** Scaled thumbnail size (kind "image" / image-type rows only). */
  thumbW?: number;
  thumbH?: number;
}

export interface ObjectCardGeom {
  /**
   * Content width (px); the node box adds NODE_PADDING on both sides. Bounded
   * by NODE_MAX_CONTENT_WIDTH — a long title or field value wraps instead of
   * widening the card.
   */
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

/**
 * Everything about a row that does NOT depend on the shared key-column width,
 * including the raw `key: value` sizing (measured at the FULL cap, because
 * that is what the shared caret geometry — buildLineData — wraps it at while
 * the row is being edited, and the pill isn't drawn then).
 */
interface RowParse {
  key: string | null;
  display: string;
  kind: ValueKind;
  keyW: number;
  hasHiddenChildren: boolean;
  rawW: number;
  rawLines: number;
  /** Image rows only; its presence is what marks the row as a thumbnail. */
  thumb?: { w: number; h: number };
}

/** Row sizes that fall out once the shared key column width is known. */
interface RowSize {
  height: number;
  dispW: number;
  displayLines: string[];
}

/**
 * Width a row's value column gives up to the key column — the one place this
 * offset is defined, shared by the width budget below and the canvas draw.
 */
export function rowKeyColOffset(key: string | null, keyColW: number): number {
  return key !== null ? keyColW + KEY_GAP : 0;
}

function parseRow(child: MindMapModel, raw: string): RowParse {
  const type = child.type ?? "text";
  const hasHiddenChildren = child.children.length > 0;

  if (type === "image") {
    const d = imageDisplaySize(raw);
    const scale = Math.min(1, ROW_THUMB_MAX_W / d.w, ROW_THUMB_MAX_H / d.h);
    const thumb = {
      w: Math.max(1, d.w * scale),
      h: Math.max(1, d.h * scale),
    };
    return {
      key: null,
      display: "",
      kind: "image",
      keyW: 0,
      hasHiddenChildren,
      rawW: thumb.w,
      rawLines: 1,
      thumb,
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

  const keyW = key
    ? Math.min(measureNodeBox(key, { fontSize: KEY_FONT_SIZE }).width, KEY_COL_MAX)
    : 0;
  const rawBox = measureNodeBox(raw);
  return {
    key,
    display,
    kind,
    keyW,
    hasHiddenChildren,
    rawW: rawBox.width,
    rawLines: rawBox.lineCount,
  };
}

/**
 * Size a row's value against the width still available to it. Values wrap into
 * the room left by the key column and the hidden-children pill, so however long
 * a field gets the card can never grow past NODE_MAX_CONTENT_WIDTH; the row
 * just gets taller.
 */
function measureRow(p: RowParse, keyColW: number): RowSize {
  if (p.thumb) {
    return { height: p.thumb.h + ROW_V_PAD, dispW: p.thumb.w, displayLines: [] };
  }

  const valueMax =
    NODE_MAX_CONTENT_WIDTH -
    rowKeyColOffset(p.key, keyColW) -
    (p.hasHiddenChildren ? ROW_BADGE_W : 0);
  // The row must fit BOTH renderings: the two-column display and the raw
  // `key: value` text shown while the row is being edited.
  const disp = wrapNodeText(p.display === "" ? "empty" : p.display, {
    maxWidth: Math.max(1, valueMax),
  });
  const lineCount = Math.max(p.rawLines, disp.lines.length);
  return {
    height: Math.max(ROW_MIN_H, lineCount * LINE_HEIGHT + ROW_V_PAD),
    dispW: disp.width,
    displayLines: p.display === "" ? [] : disp.lines,
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

  // Two passes: the key column is shared across rows, and how much width a
  // value has left to wrap into depends on it.
  const parsed = node.children.map((child) =>
    parseRow(child, editing?.id === child.id ? editing.text : child.text)
  );
  const keyColW = parsed.reduce((w, p) => Math.max(w, p.keyW), 0);

  let width = Math.max(CARD_MIN_CONTENT_W, titleBox.width);
  const rows: CardRowGeom[] = [];
  let top = sepY + CARD_ROWS_TOP;
  parsed.forEach((p, i) => {
    const size = measureRow(p, keyColW);
    const colsW =
      rowKeyColOffset(p.key, keyColW) +
      size.dispW +
      (p.hasHiddenChildren ? ROW_BADGE_W : 0);
    width = Math.max(width, p.rawW, colsW);
    rows.push({
      id: node.children[i].id,
      index: i,
      key: p.key,
      display: p.display,
      displayLines: size.displayLines,
      kind: p.kind,
      top,
      height: size.height,
      thumbW: p.thumb?.w,
      thumbH: p.thumb?.h,
    });
    top += size.height;
  });
  if (rows.length === 0) {
    top += CARD_HINT_H;
    // The "add field" button must fit inside the card too.
    width = Math.max(width, addFieldButtonWidth());
  }

  return { width, height: top + CARD_BOTTOM, titleCenterY, sepY, keyColW, rows };
}
