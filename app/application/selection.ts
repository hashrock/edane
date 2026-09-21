/**
 * Application layer: multi-node selection gestures (issue #171).
 *
 * A click's modifier keys decide what happens to the multi-selection
 * (`ViewState.selectedIds`):
 *  - plain click: no modifier held — the caller's normal activateNode path
 *    handles it, which clears the selection as a side effect (see
 *    editorReducer.ts). This module is never consulted for that case.
 *  - ctrl/cmd-click: toggle the clicked node in/out of the selection.
 *  - shift-click: select the flat-order range between the active node (the
 *    anchor) and the clicked one, inclusive, replacing any existing set.
 *
 * Pure and DOM-free — takes the document and plain booleans, returns plain
 * ids — so it can be exercised the same way as every other tree-shaped
 * decision in this codebase (getFlatOrder-based), independent of Konva/React.
 */
import {
  findNode,
  nextCheckedStateForGroup,
  getFlatOrder,
  type MindMapDocument,
} from "../domain/model";
import { supportsCheckbox } from "./nodeUtils";

export interface SelectionModifiers {
  shiftKey: boolean;
  /** ctrl on Windows/Linux, cmd (meta) on macOS — both mean "toggle one in/out". */
  toggleKey: boolean;
}

/**
 * The multi-selection set after a modifier-clicked node, or `[]` when
 * neither modifier is held. A caller can unconditionally call this on every
 * click and dispatch `setSelectedIds` with the result only when it's
 * non-empty, falling back to its plain single-select path otherwise.
 */
export function nextMultiSelection(
  doc: MindMapDocument,
  activeId: string | null,
  current: readonly string[],
  clickedId: string,
  mods: SelectionModifiers
): string[] {
  if (mods.shiftKey) {
    const order = getFlatOrder(doc);
    const anchorId = activeId ?? clickedId;
    const anchorIdx = order.indexOf(anchorId);
    const clickedIdx = order.indexOf(clickedId);
    if (anchorIdx === -1 || clickedIdx === -1) return [clickedId];
    const [lo, hi] =
      anchorIdx <= clickedIdx ? [anchorIdx, clickedIdx] : [clickedIdx, anchorIdx];
    return order.slice(lo, hi + 1);
  }
  if (mods.toggleKey) {
    // The active node is conceptually "selected" even when selectedIds is
    // still empty (see ViewState.selectedIds), so the FIRST toggle-click
    // starts a two-node selection with it rather than replacing it.
    const base = new Set(current.length > 0 ? current : activeId ? [activeId] : []);
    if (base.has(clickedId)) base.delete(clickedId);
    else base.add(clickedId);
    return Array.from(base);
  }
  return [];
}

/**
 * What a bulk "toggle task" gesture over a multi-selection does: which of
 * the selected ids to touch, and the single target state to move them all
 * to (see {@link nextCheckedStateForGroup}). Single authority for both bulk
 * entry points — the checkbox click (MindmapEditor) and the ⌘/Ctrl+Shift+D
 * keyboard shortcut (editorKeymap) — the same way `nextCheckedState` is the
 * one authority for their single-node counterparts, so the two bulk paths
 * can't quietly drift on which nodes qualify.
 *
 * `requireExisting`: a CLICK on the checkbox never creates one (that's what
 * the single-node click handler does too — see MindmapEditor's setChecked
 * call site), so the bulk click path only touches nodes that already show a
 * box. The keyboard shortcut, like its single-node sibling, may turn an
 * eligible node into a task for the first time.
 *
 * Returns null when nothing in the selection qualifies (nothing to dispatch).
 */
export function planGroupCheckToggle(
  doc: MindMapDocument,
  ids: readonly string[],
  opts: { requireExisting: boolean }
): { nodeIds: string[]; checked: boolean } | null {
  const eligible = ids
    .map((id) => findNode(doc, id))
    .filter(
      (n): n is NonNullable<typeof n> =>
        !!n &&
        supportsCheckbox(n.type ?? "text") &&
        (!opts.requireExisting || n.checked !== undefined)
    );
  if (eligible.length === 0) return null;
  return {
    nodeIds: eligible.map((n) => n.id),
    checked: nextCheckedStateForGroup(eligible.map((n) => n.checked)),
  };
}
