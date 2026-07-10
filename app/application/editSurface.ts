/**
 * Application layer: the editing-surface contract every node type must obey.
 *
 * THE INVARIANT (keyboard-escape): wherever the editing focus lives — the
 * shared keymap textarea or a node-specific input — an unmodified ArrowUp /
 * ArrowDown must either move the caret between lines inside the node or move
 * the selection to the adjacent node. It must NEVER fall through to native
 * single-line handling and do nothing, which traps the keyboard inside the
 * field ("閉じ込め").
 *
 * Two mechanisms enforce it:
 *  - EDIT_SURFACE below: every NodeType must declare which surface edits it.
 *    Adding a NodeType without a declaration is a compile error, and the
 *    declaration tells you what to wire up.
 *  - keyboardEscape.browser.test.tsx: drives every NodeType in both editors
 *    (canvas / outline) and asserts arrows always reach the neighbour node.
 */

import type { EditorAction, EditorState, UndoType } from "./editorReducer";
import type { NodeType } from "../domain/model";

export type EditSurface =
  /**
   * The node's text is edited in the shared textarea wired to editorKeymap
   * (hidden on canvas, row overlay in the outline). The keymap's edit-up /
   * edit-down bindings guarantee the invariant — nothing extra to do.
   */
  | { kind: "keymap-textarea" }
  /**
   * The node gets its own focused input (e.g. the URL box) that the keymap
   * never sees. Its onKeyDown MUST call {@link handleAuxInputKeys} first and
   * defer to native handling only when it returns "pass".
   */
  | { kind: "aux-input" }
  /**
   * Edit intent opens a side panel for the node's document instead of editing
   * inline (canvas markdown). The panel must NOT steal the keyboard on open —
   * the editor drops back to selection mode so arrows keep navigating nodes —
   * and Escape inside the panel must close it.
   */
  | { kind: "modal-panel" };

/** The two editor layouts a note can be edited in. */
export type EditorLayout = "canvas" | "outline";

/**
 * Which surface edits each node type, per layout. `satisfies` makes this
 * exhaustive both ways: adding a member to NodeType (or a new layout) refuses
 * to compile until every cell is declared here — and the declaration tells
 * you which wiring (keymap / handleAuxInputKeys / panel contract) the new
 * type needs. keyboardEscape.browser.test.tsx reads this table and verifies
 * the invariant against the real DOM for every cell.
 */
export const EDIT_SURFACE = {
  canvas: {
    text: { kind: "keymap-textarea" },
    markdown: { kind: "modal-panel" },
    object: { kind: "keymap-textarea" },
    image: { kind: "aux-input" },
    link: { kind: "aux-input" },
  },
  outline: {
    text: { kind: "keymap-textarea" },
    markdown: { kind: "keymap-textarea" },
    object: { kind: "keymap-textarea" },
    image: { kind: "aux-input" },
    link: { kind: "aux-input" },
  },
} as const satisfies Record<EditorLayout, Record<NodeType, EditSurface>>;

/** The key facts handleAuxInputKeys needs; both React's synthetic event and a
 *  native KeyboardEvent satisfy it. */
export interface AuxKeyEvent {
  key: string;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  preventDefault: () => void;
  /** React synthetic events carry the DOM event here; used for the IME guard. */
  nativeEvent?: { isComposing?: boolean };
}

/**
 * Shared onKeyDown routing for aux-input surfaces. Enforces the invariant in
 * one place so a new node-specific input can't forget it:
 *
 *  - Enter / Escape  → exit editing (back to selection-mode navigation)
 *  - plain ↑ / ↓     → move to the previous / next node (a single-line input
 *                      has no line to move within, so arrows always cross)
 *  - anything else   → "pass": leave it to the native input (←/→ caret moves,
 *                      typing, shortcuts)
 *
 * Returns "handled" after calling preventDefault, mirroring editorKeymap.
 */
export function handleAuxInputKeys(
  e: AuxKeyEvent,
  dispatch: (action: EditorAction, undoType?: UndoType) => EditorState
): "handled" | "pass" {
  // IME composition owns Enter (confirm) and arrows (candidate selection).
  if (e.nativeEvent?.isComposing) return "pass";
  if (e.key === "Enter" || e.key === "Escape") {
    e.preventDefault();
    dispatch({ type: "exitEditing" });
    return "handled";
  }
  const mod = e.altKey || e.metaKey || e.ctrlKey;
  if (e.key === "ArrowUp" && !mod) {
    e.preventDefault();
    dispatch({ type: "moveUp" });
    return "handled";
  }
  if (e.key === "ArrowDown" && !mod) {
    e.preventDefault();
    dispatch({ type: "moveDown" });
    return "handled";
  }
  return "pass";
}
