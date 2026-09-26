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

import { generateId, type MindMapModel } from "../domain/model";
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
 *
 * A branch is always pasted by NESTING it under the active node (see
 * `pasteBranch` in editorReducer.ts) — it never lands as a document root
 * directly — so `normalizeTree` is called with `isRoot: false`: `position` is
 * meaningful only on a root, and a branch is never one. `nestUnder` would
 * drop a smuggled `position` at paste time anyway, but asserting `isRoot:
 * false` here means that holds by construction rather than by relying on
 * every future caller of a parsed branch to route through `nestUnder`.
 */
export function parseBranch(text: string): MindMapModel | null {
  if (!text) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  return normalizeTree(data, new Set(), generateId, false);
}
