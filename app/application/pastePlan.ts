/**
 * Application layer: what a paste should do.
 *
 * The canvas editor's paste handler used to carry the whole decision as a
 * ladder of `if`s mixed with DOM/dispatch side effects. {@link planPaste} pulls
 * the decision out as a pure function of "what is on the clipboard" × "which
 * mode the editor is in", so the handler only executes the chosen plan.
 *
 * The rule that motivates the mode argument: **while the caret is inside a
 * node's text, a paste is a plain text paste.** No dialog, no node
 * decomposition — the clipboard text lands at the caret (replacing the
 * selection) exactly like typing would. Branch/Markdown/outline handling is
 * for selection mode, where "paste" means "paste nodes into the tree".
 *
 * Depends on {@link looksLikeMarkdown} only (no DOM / React / reducer).
 */

import { looksLikeMarkdown } from "./markdown";

/** Everything the decision depends on, read off the clipboard event + state. */
export interface PasteContext {
  /** True while editing a node's text (caret in the textarea). */
  editing: boolean;
  /** `text/plain` payload of the clipboard ("" when absent). */
  text: string;
  /** An edane branch (custom MIME JSON) rides along on the clipboard. */
  hasBranchJson: boolean;
  /** The internal branch clipboard (copyBranch/cutBranch) is non-empty. */
  hasInternalClipboard: boolean;
}

/**
 * The chosen action.
 *  - `native`: let the textarea insert the text at the caret (this is also the
 *    only outcome while editing).
 *  - `branch-json`: paste the clipboard's full-fidelity subtree as a child.
 *  - `markdown-dialog`: ask decompose / markdown node / plain text.
 *  - `branch-clipboard`: paste the internal branch clipboard as a child.
 *  - `text-as-nodes`: turn indented plain text into nodes.
 *  - `none`: nothing to paste.
 */
export type PastePlan =
  | "native"
  | "branch-json"
  | "markdown-dialog"
  | "branch-clipboard"
  | "text-as-nodes"
  | "none";

export function planPaste(ctx: PasteContext): PastePlan {
  // Editing mode: a paste is ordinary text input. Keeping this first is what
  // guarantees no dialog and no node-splitting can happen mid-text.
  if (ctx.editing) return "native";

  // Our own branch wins over its Markdown text/plain twin: both ride the same
  // clipboard, so the JSON's presence means "this is an edane branch".
  if (ctx.hasBranchJson) return "branch-json";
  // External Markdown → offer the choice dialog. Checked before the internal
  // clipboard because a cut/copied branch carries no text of its own here.
  if (looksLikeMarkdown(ctx.text)) return "markdown-dialog";
  if (ctx.hasInternalClipboard) return "branch-clipboard";
  if (!ctx.text) return "none";
  return "text-as-nodes";
}
