/**
 * Pure helpers for object-card field rows: `key: value` parsing, value-kind
 * inference and numeric display formatting.
 *
 * An object node is schemaless — a field row is just a plain child node whose
 * `text` happens to read `key: value`. These helpers derive the card's
 * key/value rendering from that text without ever transforming the stored
 * model, so converting an object card back to a text branch loses nothing.
 *
 * Kept dependency-free (domain only, no measurement/DOM) so the editor reducer
 * and Node tests can use them; the card *geometry* lives in objectCard.ts.
 */

import type { MindMapModel, NumFormat } from "../domain/model";
import { generateId } from "../domain/model";

/** What a field row's value looks like — drives the card's value rendering. */
export type ValueKind = "empty" | "number" | "url" | "image" | "date" | "text";

export interface ParsedField {
  /** Label before the first colon; null when the text has no usable key. */
  key: string | null;
  /** Everything after the colon (trimmed), or the whole text when keyless. */
  value: string;
}

const IMAGE_URL = /\.(png|jpe?g|gif|webp|avif|svg)(\?[^\s]*)?$/i;
const DATE_VALUE = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/;

/**
 * Split a row's text at its first colon (ASCII `:` or full-width `：`) into
 * key and value. A bare URL must stay a value — `https://…` would otherwise
 * parse as key "https" — so a "key" containing `/` or a value starting with
 * `//` rejects the split and the whole text is treated as a keyless value.
 */
export function parseField(text: string): ParsedField {
  const m = text.match(/^([^:：\n]{1,64})[:：]([\s\S]*)$/);
  if (!m) return { key: null, value: text };
  const key = m[1].trim();
  const value = m[2].trim();
  if (key === "" || key.includes("/") || value.startsWith("//")) {
    return { key: null, value: text };
  }
  return { key, value };
}

/** Parse a numeric value ("1,234.5" allowed); null when not a plain number. */
export function parseNumeric(value: string): number | null {
  const s = value.trim().replace(/,/g, "");
  if (s === "" || !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Infer how a field value should render. Inference only — no declared types. */
export function inferValueKind(value: string): ValueKind {
  const v = value.trim();
  if (v === "") return "empty";
  if (parseNumeric(v) !== null) return "number";
  if (/^https?:\/\//i.test(v)) return IMAGE_URL.test(v) ? "image" : "url";
  if (DATE_VALUE.test(v)) return "date";
  return "text";
}

function groupThousands(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Format a numeric field value for display. Non-numeric values (and numbers
 * with no format/decimals set) pass through unchanged — the raw text is always
 * the fallback, never an error state.
 */
export function formatFieldValue(
  value: string,
  numFormat?: NumFormat,
  decimals?: number
): string {
  const n = parseNumeric(value);
  if (n === null) return value;
  if (numFormat === undefined && decimals === undefined) return value;
  const abs = Math.abs(n);
  let s =
    decimals !== undefined
      ? abs.toFixed(Math.max(0, Math.min(6, decimals)))
      : String(abs);
  if (numFormat === "comma" || numFormat === "currency") {
    const [i, f] = s.split(".");
    s = groupThousands(i) + (f ? "." + f : "");
  }
  const sign = n < 0 ? "-" : "";
  if (numFormat === "currency") return `${sign}¥${s}`;
  if (numFormat === "percent") return `${sign}${s}%`;
  return sign + s;
}

/**
 * "Schema by example": a fresh sibling card for an object node, prefilling the
 * source card's keys with empty values (display formats carried over) so a run
 * of same-shaped cards types like filling spreadsheet rows. Keyless rows and
 * content rows (image/link/markdown) are notes, not schema — skipped.
 */
export function objectSiblingTemplate(node: MindMapModel): MindMapModel {
  const children: MindMapModel[] = [];
  for (const child of node.children) {
    if (child.type) continue;
    const { key } = parseField(child.text);
    if (!key) continue;
    const row: MindMapModel = { id: generateId(), text: `${key}: `, children: [] };
    if (child.numFormat) row.numFormat = child.numFormat;
    if (child.decimals !== undefined) row.decimals = child.decimals;
    children.push(row);
  }
  return { id: generateId(), text: "", type: "object", children };
}
