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
 *  - Shift+↑/↓ (canvas): grow or shrink that same range one node at a time
 *    ({@link extendSelection}) — the keyboard's way to select whole lines.
 *
 * Pure and DOM-free — takes the document and plain booleans, returns plain
 * ids — so it can be exercised the same way as every other tree-shaped
 * decision in this codebase (getFlatOrder-based), independent of Konva/React.
 */
import {
  findNode,
  locateNode,
  nextCheckedStateForGroup,
  getFlatOrder,
  subtreeIds,
  type MindMapDocument,
} from "../domain/model";
import { supportsCheckbox } from "./nodeUtils";
import { modelToText } from "./persistence";

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
  const eligible = checkboxEligible(doc, ids).filter(
    (n) => !opts.requireExisting || n.checked !== undefined
  );
  if (eligible.length === 0) return null;
  return {
    nodeIds: eligible.map((n) => n.id),
    checked: nextCheckedStateForGroup(eligible.map((n) => n.checked)),
  };
}

/**
 * The ids a checkbox CONTEXT-MENU item acts on, split by what the item can do
 * to them: `plain` nodes have no box yet ("add a checkbox" creates one),
 * `tasked` nodes already carry one ("check"/"uncheck"/"remove" move it).
 *
 * Both lists skip ids that no longer exist or whose kind shows no box at all
 * (`supportsCheckbox`), so the menu built from them can only offer items that
 * would really do something. Splitting rather than picking one state for the
 * whole group is what lets a MIXED selection — some tasks, some plain notes —
 * offer both, instead of the plain nodes silently swallowing the toggle or the
 * tasks being reset to open by an "add" that also touched them.
 */
export function checkboxMenuTargets(
  doc: MindMapDocument,
  ids: readonly string[]
): { plain: string[]; tasked: string[] } {
  const eligible = checkboxEligible(doc, ids);
  return {
    plain: eligible.filter((n) => n.checked === undefined).map((n) => n.id),
    tasked: eligible.filter((n) => n.checked !== undefined).map((n) => n.id),
  };
}

/**
 * The selected nodes that can carry a checkbox at all, in the order the ids
 * came in. Shared by the two functions above so "which nodes does a checkbox
 * gesture even look at" is answered once: ids read from a possibly-stale view
 * may name a deleted node, and a kind like image/markdown never shows a box.
 */
function checkboxEligible(doc: MindMapDocument, ids: readonly string[]) {
  return ids
    .map((id) => findNode(doc, id))
    .filter(
      (n): n is NonNullable<typeof n> =>
        !!n && supportsCheckbox(n.type ?? "text")
    );
}

/**
 * What a bulk collapse/expand over a selection does: which of the ids can fold
 * at all (a leaf has nothing to hide), and the single state to move them all
 * to. Mixed groups get one answer that doesn't depend on which node happened
 * to be read — fold everyone unless they are ALL already folded, in which case
 * open them all, exactly as {@link nextCheckedStateForGroup} decides the
 * checkbox one. Over a single id it is the plain flip the menu always did.
 *
 * Returns null when nothing in the selection has children.
 */
export function planGroupCollapse(
  doc: MindMapDocument,
  ids: readonly string[]
): { nodeIds: string[]; collapsed: boolean } | null {
  const parents = ids
    .map((id) => findNode(doc, id))
    .filter((n): n is NonNullable<typeof n> => !!n && n.children.length > 0);
  if (parents.length === 0) return null;
  return {
    nodeIds: parents.map((n) => n.id),
    collapsed: !parents.every((n) => n.collapsed === true),
  };
}

/**
 * The selected branches, in document order and without the ids that sit INSIDE
 * another selected one. What every "act on the selected branches as wholes"
 * operation wants: copying a parent and its own child would otherwise put that
 * child's text in the clipboard twice, once on its own and once inside its
 * parent's block.
 *
 * Order is the document's own DFS, so a ctrl/cmd-click selection built in
 * whatever order the user clicked still reads out top to bottom, like a
 * shift-click range already does. Collapsed branches are walked too
 * (unlike {@link getFlatOrder}): folding a branch hides its nodes, it doesn't
 * drop them out of a selection that already named them.
 */
export function outermostBranches(
  doc: MindMapDocument,
  ids: readonly string[]
): string[] {
  const selected = new Set(ids);
  const insideAnother = (id: string) => {
    let parent = locateNode(doc, id)?.parent ?? null;
    while (parent) {
      if (selected.has(parent.id)) return true;
      parent = locateNode(doc, parent.id)?.parent ?? null;
    }
    return false;
  };
  const order = doc.roots.flatMap(subtreeIds);
  return order.filter((id) => selected.has(id) && !insideAnother(id));
}

/**
 * Shift+↑/↓: move the far end of the flat-order range that runs from the
 * active node (the anchor, as for shift-click) one node up or down, and
 * return the new range — or `[]` once it is back to the anchor alone (no
 * multi-selection). The far end is whichever end of the current selection
 * is not the anchor; with no selection yet, the range starts at the anchor.
 * Stops at the document's first / last node.
 */
export function extendSelection(
  doc: MindMapDocument,
  activeId: string,
  current: readonly string[],
  dir: -1 | 1
): string[] {
  const order = getFlatOrder(doc);
  const anchor = order.indexOf(activeId);
  if (anchor === -1) return [...current];
  const indices = [anchor, ...current.map((id) => order.indexOf(id)).filter((i) => i !== -1)];
  const lo = Math.min(...indices);
  const hi = Math.max(...indices);
  const far = anchor === lo ? hi : lo;
  const next = Math.min(Math.max(far + dir, 0), order.length - 1);
  if (next === anchor) return [];
  return order.slice(Math.min(anchor, next), Math.max(anchor, next) + 1);
}

/**
 * The selected branches as indented plain text, one block per branch in
 * document order (a node inside another selected branch is already in that
 * block — see {@link outermostBranches}). What copying a multi-selection puts
 * on the clipboard, from the keyboard or the context menu.
 */
export function selectionToText(doc: MindMapDocument, ids: readonly string[]): string {
  return outermostBranches(doc, ids)
    .map((id) => findNode(doc, id))
    .filter((n) => n !== null)
    // Not `.map(modelToText)`: its second parameter is the indent depth, and
    // map would hand it the array index.
    .map((branch) => modelToText(branch))
    .join("\n");
}
