/**
 * Application layer: full-fidelity branch clipboard payload.
 *
 * A branch copied/cut from edane is written to the system clipboard twice:
 *  - `text/plain` as a human-readable Markdown outline (see modelToMarkdown), so
 *    it pastes meaningfully into other apps;
 *  - {@link BRANCH_MIME} as the exact node subtree encoded as JSON, so pasting
 *    back into edane (even in another tab) round-trips node kinds, ids and
 *    formatting that Markdown alone would flatten.
 *
 * Because both ride the SAME clipboard, the presence of the JSON payload means
 * "this text/plain is our own branch" — the paste flow prefers it over the
 * Markdown dialog.
 */

import type { MindMapModel } from "../domain/model";
import { normalizeTree } from "./persistence";

/** Custom clipboard MIME carrying the JSON branch. Only edane reads it. */
export const BRANCH_MIME = "application/x-edane-branch";

/** Serialize a branch (a node and its descendants) for the clipboard. */
export function serializeBranch(node: MindMapModel): string {
  return JSON.stringify(node);
}

/**
 * Parse a branch payload from the clipboard. Returns null unless the string is
 * a well-formed node tree, so a foreign or corrupt payload is ignored rather
 * than pasted as garbage.
 *
 * Shares {@link normalizeTree} with the note-loading path (parseContent) so a
 * clipboard payload is held to the same invariant as one loaded from the DB:
 * every node gets a unique id and any optional field (`type`, `fontSize`, ...)
 * outside its declared type is dropped rather than smuggled into the model —
 * a hand-edited or foreign payload under this MIME could otherwise carry
 * anything.
 */
export function parseBranch(text: string): MindMapModel | null {
  if (!text) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  return normalizeTree(data, new Set());
}
