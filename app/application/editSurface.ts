/**
 * Application layer: the editing-surface contract every node type must obey.
 *
 * THE INVARIANT (keyboard-escape): wherever the editing focus lives — the
 * shared keymap textarea or a node-specific input — an unmodified arrow key
 * must either move the caret inside the node or move the selection to the
 * adjacent node. It must NEVER fall through to native handling and do nothing,
 * which traps the keyboard inside the field ("閉じ込め").
 *
 *  - ArrowUp / ArrowDown: walk lines within the node, cross to the
 *    previous / next node from the first / last line. A single-line field has
 *    no line to walk, so there they always cross.
 *  - ArrowLeft / ArrowRight: walk characters within the node, cross to the
 *    previous / next node from the caret's start / end edge.
 *
 * Both hold regardless of the `arrowBehavior` preference: that setting only
 * rebinds ←/→ in SELECTION mode (fold vs. move to parent/child), while this
 * invariant governs EDITING mode, where ←/→ are caret keys in every config.
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
   *
   * The converse holds once the panel's own field takes focus: the editor must
   * then leave the focus alone until the field gives it up. It stays in
   * selection mode (there is no inline caret to own), so any key that reaches
   * the canvas while the user types in the panel fires a selection shortcut —
   * Backspace deletes the node being edited, Enter adds a sibling, arrows jump
   * away. Editing through the panel feeds the node's text back into the
   * editor state, which is exactly what wakes the focus-sync effects, so this
   * is a live trap rather than a theoretical one.
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
    image: { kind: "aux-input" },
    link: { kind: "aux-input" },
  },
  outline: {
    text: { kind: "keymap-textarea" },
    markdown: { kind: "keymap-textarea" },
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
  shiftKey: boolean;
  preventDefault: () => void;
  /** React synthetic events carry the DOM event here; used for the IME guard. */
  nativeEvent?: { isComposing?: boolean };
  /**
   * The input the key landed in — needed to tell "caret mid-text" (native
   * ←/→) from "caret at an edge" (cross to the neighbour). Required, not
   * optional, so a new aux input can't silently omit it and lose the
   * horizontal half of the invariant. `HTMLInputElement` satisfies it.
   */
  currentTarget: {
    value: string;
    selectionStart: number | null;
    selectionEnd: number | null;
  };
}

/**
 * Shared onKeyDown routing for aux-input surfaces. Enforces the invariant in
 * one place so a new node-specific input can't forget it:
 *
 *  - Enter / Escape  → exit editing (back to selection-mode navigation)
 *  - plain ↑ / ↓     → move to the previous / next node (a single-line input
 *                      has no line to move within, so arrows always cross)
 *  - plain ← / →     → cross to the previous / next node when the caret sits
 *                      at the start / end edge; native caret move otherwise.
 *                      Mirrors edit-left / edit-right in editorKeymap so the
 *                      URL box escapes exactly like the shared textarea.
 *  - anything else   → "pass": leave it to the native input (typing,
 *                      Shift-selection, ⌘/Ctrl word jumps, shortcuts)
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
  // ←/→ are caret keys, so they only cross at the edges — but a single-line
  // input silently ignores ← at position 0 and → at the end, which is exactly
  // the trap this invariant forbids. Shift extends a selection and ⌘/Ctrl/Alt
  // jump by word; both stay native (the invariant covers unmodified arrows).
  if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !mod && !e.shiftKey) {
    const { value, selectionStart, selectionEnd } = e.currentTarget;
    // No readable caret (an input type that doesn't expose one): escape rather
    // than pass, since "can't tell" must not resolve to "possibly trapped".
    const caret =
      selectionStart === null || selectionEnd === null ? null : selectionStart;
    // A non-empty range collapses to one side natively — that IS caret
    // movement, so let it happen and cross on the next press.
    if (caret !== null && selectionStart !== selectionEnd) return "pass";
    if (e.key === "ArrowLeft" && (caret === null || caret === 0)) {
      e.preventDefault();
      dispatch({ type: "arrowLeftEdge" });
      return "handled";
    }
    if (e.key === "ArrowRight" && (caret === null || caret === value.length)) {
      e.preventDefault();
      dispatch({ type: "arrowRightEdge" });
      return "handled";
    }
  }
  return "pass";
}
