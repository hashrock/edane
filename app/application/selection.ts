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
import { getFlatOrder, type MindMapDocument } from "../domain/model";

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
