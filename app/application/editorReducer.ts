/**
 * Application layer: editor state reducer.
 *
 * EditorState is split into two independently-evolving parts:
 * - DocumentState (model, clipboard): the persisted, undoable document.
 * - ViewState (activeNodeId, editing, editingText, cursorPos, selectionEnd):
 *   ephemeral, UI-local selection/caret state. Not undoable.
 *
 * editorReducer() delegates to documentReducer() and viewReducer(). Most
 * actions only touch one side; structural edits (enter, backspaceAtStart,
 * cutBranch, ...) touch both — documentReducer() computes the new document
 * first (optionally reporting a `focusId` for a newly created or landing
 * node) and viewReducer() derives the new view from it.
 *
 * The reducer is pure (no React/DOM) and always returns a COMPLETE next
 * state. A no-op action returns the SAME state reference, which lets the
 * caller cheaply skip re-rendering / undo bookkeeping.
 *
 * Selection model: exactly ONE node is always active (`activeNodeId` is never
 * null). `editing` distinguishes "editing" (caret + text input) from "selected"
 * (node highlighted). Text range selection within a node uses cursorPos/
 * selectionEnd.
 *
 * Multi-node selection (`ViewState.selectedIds`) is a separate, orthogonal
 * concept layered on top for bulk operations (e.g. checking several boxes at
 * once) — see its doc comment. `activeNodeId` still names the one node a
 * click/keystroke without a bulk gesture would act on; there is no notion of
 * multiple "active" nodes.
 */

import type { IdSource, MindMapDocument, MindMapModel, NodeType } from "../domain/model";
import {
  findNode,
  locateNode,
  getFlatOrder,
  firstRootId,
  ensureRoot,
  placeBranchAt,
  addRootAt,
  generateId,
  cloneModel,
  cloneDocument,
  setDocumentTitle,
  nestUnder,
  addSiblingAfter,
  detachBranch,
  landOnPredecessor,
  cloneWithNewIds,
  indentNode,
  dedentNode,
  splitNode,
  mergeIntoPredecessor,
  mergeSuccessorInto,
  updateNodeText,
  toggleCollapse,
  addChildToNode,
  setNodeType,
  setNodeStyle,
  setChecked,
  setCheckedMany,
  setLinkMeta,
  moveNodeUp,
  moveNodeDown,
  moveBranch,
} from "../domain/model";
import { assertNever } from "../lib/assertNever";

export interface DocumentState {
  model: MindMapDocument;
  // Internal branch clipboard: the subtree captured by copyBranch / cutBranch,
  // pasted as a child of the active node by pasteBranch. null = empty.
  clipboard: MindMapModel | null;
}

export interface ViewState {
  activeNodeId: string | null;
  // When a node is active, distinguishes "editing" (caret + text input) from
  // "selected" (node highlighted, single click). Always false when no node is
  // active.
  editing: boolean;
  editingText: string;
  cursorPos: number;
  selectionEnd: number;
  /**
   * Per-parent memory of the last child that held the focus, keyed by parent
   * id. `moveToChild` (→ in selection mode) returns there instead of always
   * dropping onto the first child, so walking ← up and → back down lands where
   * you left off — the Finder column-view model.
   *
   * Navigation state, not document state: never persisted with the note, and
   * intentionally not restored by undo (see undoManager — undo swaps the
   * document, the view memory keeps describing where the user has been).
   * Entries are never pruned; a stale one is filtered out at lookup time by
   * checking it against the live children, which also covers the node being
   * deleted or moved to another parent.
   */
  lastChildByParent: Record<string, string>;
  /**
   * Node ids explicitly multi-selected (ctrl/cmd-click adds/removes one,
   * shift-click selects a flat-order range — see application/selection.ts),
   * for bulk operations like checking several boxes at once. Absent — not an
   * empty array — means "no multi-selection": `activeNodeId` alone is
   * selected, the pre-existing behavior, mirroring how MindMapModel.checked
   * being absent means "not a task" rather than "unchecked".
   *
   * Only `setSelectedIds` ever sets this. Every OTHER action clears it back
   * to absent (enforced once, at the tail of {@link editorReducer}) so a
   * multi-selection can never linger through an edit or a focus change it
   * wasn't part of — the same "no path may skip the invariant" reasoning as
   * the caret bound in {@link withCaretInBuffer}. `setCheckedMany` is the one
   * exception: it acts ON the current selection, so it leaves it in place for
   * a follow-up bulk action.
   */
  selectedIds?: string[];
}

export interface EditorState {
  document: DocumentState;
  view: ViewState;
}

// The undo-entry label passed as dispatch()'s second argument. Purely
// descriptive (UndoManager stores it but doesn't yet branch on it) — this
// union exists so a typo or a new label collides at compile time instead of
// silently producing an inconsistent entry (e.g. "delete" vs "delete-node"
// for what is otherwise the same kind of edit).
export type UndoType =
  | "add-child"
  | "add-root"
  | "cut-branch"
  | "paste-branch"
  | "collapse"
  | "delete"
  | "delete-node"
  | "reorder"
  | "insert-sibling"
  | "indent"
  | "backspace"
  | "enter"
  | "image-upload"
  | "style"
  | "move-branch"
  | "paste"
  | "link-meta"
  | "check"
  | "set-type";

export type EditorAction =
  // --- structural keyboard edits ---
  | { type: "enter"; pos: number }
  | { type: "tab"; shift: boolean }
  | { type: "backspaceAtStart" }
  | { type: "deleteAtEnd"; pos: number }
  // Reorder the active node among its siblings (depth unchanged). Structural
  // and undoable, unlike the pure navigation actions below.
  | { type: "moveNodeUp" }
  | { type: "moveNodeDown" }
  // Drag & drop: move a whole subtree under a new parent (index = insertion
  // position among the parent's current children; absent = append).
  | { type: "moveBranch"; nodeId: string; newParentId: string; index?: number }
  // Put a tree at a free canvas position: dropping a ROOT on empty canvas
  // (free placement), or the node menu's "detach as a new tree", which cuts a
  // nested branch out of its tree and drops it at its current layout anchor.
  // Dropping a NESTED node on empty canvas is a no-drop — see MindmapEditor.
  | { type: "placeBranchAt"; nodeId: string; x: number; y: number }
  // Context menu on empty canvas: a new blank root at that position, handed
  // straight into edit mode.
  | { type: "addRootAt"; x: number; y: number }
  // --- navigation ---
  | { type: "moveUp" }
  | { type: "moveDown" }
  // Sibling-first vertical navigation: the canvas's ↑/↓ in selection mode.
  // moveUp/moveDown walk the flat (outline) order, which on a two-dimensional
  // canvas means dropping into a neighbouring branch; these move among the
  // node's own siblings — what actually sits above and below it — and, once
  // those run out, leave the branch (up: to the parent; down: over the whole
  // subtree to the next node at any level) so ↑/↓ never dead-end mid-tree.
  // They never descend into children: that is → 's job.
  | { type: "moveUpSiblingFirst" }
  | { type: "moveDownSiblingFirst" }
  // Move focus to the active node's parent (Left in selection mode on a leaf /
  // collapsed node).
  | { type: "moveToParent" }
  | { type: "cmdLeft"; pos: number }
  | { type: "cmdRight"; pos: number }
  | { type: "cmdShiftLeft"; pos: number; selEnd: number }
  | { type: "cmdShiftRight"; pos: number; selEnd: number }
  | { type: "arrowLeftEdge" }
  | { type: "arrowRightEdge" }
  | { type: "moveToChild" }
  // --- text input ---
  | {
      type: "typeText";
      text: string;
      cursorPos: number;
      selectionEnd: number;
      // false while an IME composition is in progress (don't commit to model yet)
      commitModel: boolean;
    }
  | { type: "setSelection"; cursorPos: number; selectionEnd: number }
  // --- branch clipboard ---
  | { type: "copyBranch" }
  | { type: "cutBranch" }
  // Paste a branch as a child of the active node. Without `node`, the internal
  // clipboard (set by copyBranch/cutBranch) is used; with `node`, that explicit
  // subtree is pasted instead (an external branch decoded from the system
  // clipboard) and the internal clipboard is left untouched.
  | { type: "pasteBranch"; node?: MindMapModel }
  // --- pointer ---
  | {
      type: "activateNode";
      nodeId: string;
      cursorPos: number;
      selectionEnd: number;
      // false = just select the node (single click); true = enter edit mode.
      editing: boolean;
    }
  | { type: "selectAllInNode"; nodeId: string }
  // Enter edit mode on the currently-selected node (double click / Enter /
  // typing). `cursorPos`/`selectionEnd` default to selecting the whole text.
  | { type: "startEditing"; cursorPos?: number; selectionEnd?: number }
  // Leave edit mode but keep the node selected (Escape from editing).
  | { type: "exitEditing" }
  // Drag within a node selects a text range (an editing gesture). Selection
  // never crosses node boundaries — there is no multi-node selection.
  | {
      type: "dragSelect";
      nodeId: string;
      anchorOffset: number;
      focusOffset: number;
    }
  // Insert an empty sibling right after the active node (or `nodeId` when
  // given — the context menu targets the right-clicked node, which need not be
  // active) and edit it (Enter in selection mode). Falls back to a child when
  // a tree root is the target.
  | { type: "insertSiblingAfter"; nodeId?: string }
  // --- context-menu node ops ---
  | { type: "toggleCollapse"; nodeId: string }
  | { type: "addChild"; nodeId: string }
  | { type: "deleteNode"; nodeId: string }
  | { type: "setNodeType"; nodeId: string; nodeType: NodeType }
  | {
      type: "setNodeContent";
      nodeId: string;
      text: string;
      nodeType?: NodeType;
    }
  | {
      type: "setNodeStyle";
      nodeId: string;
      fontSize?: number | null;
      bold?: boolean;
    }
  | {
      type: "setLinkMeta";
      nodeId: string;
      linkTitle?: string;
      favicon?: string | null;
    }
  // Task checkbox; `null` removes it (the node stops being a task).
  | { type: "setChecked"; nodeId: string; checked: boolean | null }
  // --- multi-select ---
  // Replace the whole multi-selection set (ctrl/cmd-click toggle, shift-click
  // range — computed by the caller; see application/selection.ts). Empty
  // clears it back to just the active node.
  | { type: "setSelectedIds"; ids: string[] }
  // Bulk form of setChecked: apply the same checkbox state to every id (see
  // domain/model.ts's setCheckedMany). `null` removes the checkbox from all.
  | { type: "setCheckedMany"; nodeIds: string[]; checked: boolean | null }
  // --- bulk / misc ---
  | { type: "insertNodes"; targetId: string; nodes: MindMapModel[] }
  | { type: "setTitle"; text: string }
  | { type: "replace"; state: EditorState };

// --- Document reducer ---

interface DocumentResult {
  document: DocumentState;
  // Present when the action focuses a specific node in the new document —
  // either newly created (enter/addChild) or an existing landing node
  // (backspaceAtStart/cutBranch/pasteBranch/deleteNode/toggleCollapse/
  // setNodeType/insertNodes). viewReducer() resolves this node's current
  // text; it's the document-side analogue of the old focusNodeState helper.
  focusId?: string;
  // Caret override for focusId: defaults to the end of the focused node's
  // text (see viewReducer's focusView), but a split (enter mid-text) or a
  // merge (backspaceAtStart) lands the caret at the pre-edit boundary, not
  // the end of the new/merged text.
  focusCursorPos?: number;
  focusSelectionEnd?: number;
}

function documentReducer(
  document: DocumentState,
  action: EditorAction,
  // The view facts a document edit may depend on (which node, and whether it
  // is being edited) — one context rather than a positional flag per fact.
  view: Pick<ViewState, "activeNodeId" | "editing">,
  nextId: IdSource
): DocumentResult {
  const { activeNodeId, editing } = view;
  switch (action.type) {
    case "enter": {
      if (!activeNodeId) return { document };
      const { model } = document;
      const currentNode = findNode(model, activeNodeId);
      if (!currentNode) return { document };


      if (action.pos >= currentNode.text.length) {
        const newId = nextId();
        const newNode: MindMapModel = { id: newId, text: "", children: [] };
        return {
          document: {
            ...document,
            model: addSiblingAfter(model, activeNodeId, newNode),
          },
          focusId: newId,
        };
      }

      if (action.pos <= 0) {
        // At the start: insert an empty line *above* and keep the caret on this
        // node (its id, text and children are untouched — splitting a line must
        // never move a node's content onto a fresh id, see splitNode).
        const result = splitNode(model, activeNodeId, 0, nextId);
        return {
          document: { ...document, model: result.doc },
          focusId: activeNodeId,
          focusCursorPos: 0,
          focusSelectionEnd: 0,
        };
      }

      // Mid-text split: the prefix stays on this node (keeps its id + children),
      // the suffix becomes a following sibling; the caret lands at its start.
      const result = splitNode(model, activeNodeId, action.pos, nextId);
      return {
        document: { ...document, model: result.doc },
        focusId: result.newNodeId,
        focusCursorPos: 0,
        focusSelectionEnd: 0,
      };
    }

    case "tab": {
      if (!activeNodeId) return { document };
      const newModel = action.shift
        ? dedentNode(document.model, activeNodeId)
        : indentNode(document.model, activeNodeId);
      return { document: { ...document, model: newModel } };
    }

    case "moveNodeUp":
    case "moveNodeDown": {
      if (!activeNodeId) return { document };
      const newModel =
        action.type === "moveNodeUp"
          ? moveNodeUp(document.model, activeNodeId)
          : moveNodeDown(document.model, activeNodeId);
      // moveNode* returns the same reference when the move is impossible; keep
      // the document identity so the reducer skips undo/save for a no-op.
      if (newModel === document.model) return { document };
      return { document: { ...document, model: newModel }, focusId: activeNodeId };
    }

    case "moveBranch": {
      const moved = moveBranch(
        document.model,
        action.nodeId,
        action.newParentId,
        action.index
      );
      // moveBranch returns the same reference when the move is impossible or a
      // no-op; keep the document identity so undo/save are skipped.
      if (moved === document.model) return { document };
      // moveBranch expanded the drop target (see nestUnder), so the moved
      // node is visible to take the focus.
      return { document: { ...document, model: moved }, focusId: action.nodeId };
    }

    case "placeBranchAt": {
      const placed = placeBranchAt(document.model, action.nodeId, {
        x: action.x,
        y: action.y,
      });
      if (placed === document.model) return { document };
      return {
        document: { ...document, model: placed },
        focusId: action.nodeId,
      };
    }

    case "backspaceAtStart": {
      if (!activeNodeId) return { document };
      const { model } = document;
      const currentNode = findNode(model, activeNodeId);
      if (!currentNode) return { document };

      // Merge into the structural predecessor (previous sibling or parent), not
      // the DFS-previous node, so the node's text and children never scatter
      // into an unrelated subtree.
      const merged = mergeIntoPredecessor(model, activeNodeId);
      if (!merged) return { document };
      return {
        document: { ...document, model: merged.doc },
        focusId: merged.targetId,
        // Caret lands at the merge boundary, not the end of the merged text.
        focusCursorPos: merged.caretPos,
        focusSelectionEnd: merged.caretPos,
      };
    }

    case "deleteAtEnd": {
      if (!activeNodeId) return { document };
      const { model } = document;
      const currentNode = findNode(model, activeNodeId);
      if (!currentNode) return { document };
      if (action.pos < currentNode.text.length) return { document };

      // Pull the structural successor (first visible child or next sibling) up
      // into this node — the mirror of backspaceAtStart. No successor within the
      // node's own subtree/siblings → no-op (identity preserved).
      const newModel = mergeSuccessorInto(model, activeNodeId);
      if (newModel === model) return { document };
      // Hand the (now longer) node back through the generic focus path so the
      // view's editingText follows the merge; the caret stays at the join.
      // The join is the PRE-merge length, not `action.pos`: focusCursorPos is a
      // model position (as in backspaceAtStart), while `action.pos` is an
      // offset into the textarea's value, which the reducer cannot assume is
      // the same string. Any caret at or past the end of the node means the
      // same thing here — the join — so read it from the model.
      const joinPos = currentNode.text.length;
      return {
        document: { ...document, model: newModel },
        focusId: activeNodeId,
        focusCursorPos: joinPos,
        focusSelectionEnd: joinPos,
      };
    }

    case "typeText": {
      if (!activeNodeId || !action.commitModel) return { document };
      return {
        document: {
          ...document,
          model: updateNodeText(document.model, activeNodeId, action.text),
        },
      };
    }

    case "copyBranch": {
      if (!activeNodeId) return { document };
      const node = findNode(document.model, activeNodeId);
      if (!node) return { document };
      return { document: { ...document, clipboard: cloneModel(node) } };
    }

    case "cutBranch": {
      const { model } = document;
      if (!activeNodeId) return { document };
      const { doc: newModel, removed } = detachBranch(model, activeNodeId);
      if (!removed) return { document };
      // Cutting the last root empties the document; editorReducer() restores
      // a blank root and refocuses it (see ensureRoot below).
      return {
        document: { model: newModel, clipboard: removed },
        focusId: landOnPredecessor(model, activeNodeId, newModel),
      };
    }

    case "pasteBranch": {
      const { model, clipboard } = document;
      // An explicit `node` (external clipboard) takes priority; otherwise fall
      // back to the internal branch clipboard.
      const source = action.node ?? clipboard;
      if (!activeNodeId || !source) return { document };
      const target = findNode(model, activeNodeId);
      if (!target) return { document };
      const fresh = cloneWithNewIds(source, nextId);
      // addChildToNode expands the target (see nestUnder), so the pasted
      // child is visible.
      const newModel = addChildToNode(model, activeNodeId, fresh);
      // Keep the clipboard so the branch can be pasted again.
      return {
        document: { model: newModel, clipboard },
        focusId: fresh.id,
      };
    }

    case "addRootAt": {
      const newNode: MindMapModel = { id: nextId(), text: "", children: [] };
      return {
        document: {
          ...document,
          model: addRootAt(document.model, newNode, { x: action.x, y: action.y }),
        },
        focusId: newNode.id,
        focusCursorPos: 0,
        focusSelectionEnd: 0,
      };
    }

    case "insertNodes": {
      const { targetId, nodes } = action;
      if (nodes.length === 0) return { document };
      const newModel = cloneDocument(document.model);
      const loc = locateNode(newModel, targetId);
      if (!loc) return { document };
      // Either way the nodes are nested (see nestUnder: visible, no position).
      if (loc.parent === null) {
        // A root takes them as children, not as new trees (see isRoot).
        const root = loc.siblings[loc.index];
        for (const n of nodes) nestUnder(root, { ...n });
      } else {
        const parent = loc.parent;
        nodes.forEach((n, i) => nestUnder(parent, { ...n }, loc.index + 1 + i));
      }
      const last = nodes[nodes.length - 1];
      return {
        document: { ...document, model: newModel },
        focusId: last.id,
      };
    }

    case "toggleCollapse": {
      const node = findNode(document.model, action.nodeId);
      if (!node || node.children.length === 0) return { document };
      const newModel = toggleCollapse(document.model, action.nodeId);
      const newDocument = { ...document, model: newModel };
      // If the focused node just got hidden, move focus to the toggled node.
      if (activeNodeId && !getFlatOrder(newModel).includes(activeNodeId)) {
        return { document: newDocument, focusId: action.nodeId };
      }
      return { document: newDocument };
    }

    case "insertSiblingAfter": {
      const afterId = action.nodeId ?? activeNodeId;
      if (!afterId || !findNode(document.model, afterId)) return { document };
      const newNode: MindMapModel = { id: nextId(), text: "", children: [] };
      return {
        document: {
          ...document,
          model: addSiblingAfter(document.model, afterId, newNode),
        },
        focusId: newNode.id,
        focusCursorPos: 0,
        focusSelectionEnd: 0,
      };
    }

    case "addChild": {
      const parent = findNode(document.model, action.nodeId);
      if (!parent) return { document };
      const newId = nextId();
      const newNode: MindMapModel = { id: newId, text: "", children: [] };
      // addChildToNode expands the parent (see nestUnder), so the child is visible.
      const newModel = addChildToNode(document.model, action.nodeId, newNode);
      return { document: { ...document, model: newModel }, focusId: newId };
    }

    case "deleteNode": {
      // Delete the node together with its WHOLE subtree (children are removed,
      // not promoted to the parent level).
      const { doc: newModel, removed } = detachBranch(
        document.model,
        action.nodeId
      );
      if (removed === null) return { document }; // unknown → no-op
      const newDocument = { ...document, model: newModel };
      // Only refocus if the currently active node disappeared. (Deleting the
      // last root is handled by editorReducer(): ensureRoot + refocus.)
      if (activeNodeId && !findNode(newModel, activeNodeId)) {
        return {
          document: newDocument,
          focusId: landOnPredecessor(document.model, action.nodeId, newModel),
        };
      }
      return { document: newDocument };
    }

    case "setNodeType": {
      const node = findNode(document.model, action.nodeId);
      if (!node) return { document };
      const newModel = setNodeType(
        document.model,
        action.nodeId,
        action.nodeType
      );
      // Activate the node so its URL/label can be edited as text right away.
      return {
        document: { ...document, model: newModel },
        focusId: action.nodeId,
      };
    }

    case "setNodeContent": {
      const node = findNode(document.model, action.nodeId);
      if (!node) return { document };
      let newModel = updateNodeText(document.model, action.nodeId, action.text);
      if (action.nodeType) {
        newModel = setNodeType(newModel, action.nodeId, action.nodeType);
      }
      const newDocument = { ...document, model: newModel };
      // Refocus onto the node whose content just changed if the active node
      // dropped out of the flat order, so "activeNodeId is always visible"
      // holds regardless of what a future caller passes here.
      if (activeNodeId && !getFlatOrder(newModel).includes(activeNodeId)) {
        return { document: newDocument, focusId: action.nodeId };
      }
      return { document: newDocument };
    }

    case "setNodeStyle": {
      const node = findNode(document.model, action.nodeId);
      if (!node) return { document };
      const newModel = setNodeStyle(document.model, action.nodeId, {
        fontSize: action.fontSize,
        bold: action.bold,
      });
      return { document: { ...document, model: newModel } };
    }

    case "setLinkMeta": {
      const node = findNode(document.model, action.nodeId);
      if (!node) return { document };
      const newModel = setLinkMeta(document.model, action.nodeId, {
        linkTitle: action.linkTitle,
        favicon: action.favicon,
      });
      return { document: { ...document, model: newModel } };
    }

    case "setChecked": {
      const node = findNode(document.model, action.nodeId);
      if (!node) return { document };
      const newModel = setChecked(document.model, action.nodeId, action.checked);
      return { document: { ...document, model: newModel } };
    }

    case "setCheckedMany": {
      if (action.nodeIds.length === 0) return { document };
      const newModel = setCheckedMany(document.model, action.nodeIds, action.checked);
      return { document: { ...document, model: newModel } };
    }

    case "setTitle": {
      if (action.text === document.model.title) return { document };
      return {
        document: {
          ...document,
          model: setDocumentTitle(document.model, action.text),
        },
      };
    }

    // Pure view actions: the document never changes.
    case "moveUp":
    case "moveDown":
    case "moveUpSiblingFirst":
    case "moveDownSiblingFirst":
    case "moveToParent":
    case "moveToChild":
    case "cmdLeft":
    case "cmdRight":
    case "cmdShiftLeft":
    case "cmdShiftRight":
    case "arrowLeftEdge":
    case "arrowRightEdge":
    case "setSelection":
    case "activateNode":
    case "startEditing":
    case "selectAllInNode":
    case "dragSelect":
    case "setSelectedIds":
      return { document };

    case "exitEditing": {
      // Leaving edit mode on a blank leaf node deletes it — an accidentally
      // created empty node (Enter then Escape) shouldn't linger. Never delete
      // the only root (the document must keep one — deleting it would just get
      // it replaced by another blank), and never a node that still has
      // children (its subtree would vanish with it); those just exit to
      // selection with no model change.
      if (!activeNodeId) return { document };
      // In selection mode there is no edit mode to leave (empty-canvas click,
      // post-paste): nothing may be deleted, or the view would keep pointing
      // at a node the document no longer has.
      if (!editing) return { document };
      const node = findNode(document.model, activeNodeId);
      const onlyRoot =
        document.model.roots.length === 1 &&
        document.model.roots[0].id === activeNodeId;
      if (
        !node ||
        onlyRoot ||
        node.text.trim() !== "" ||
        node.children.length > 0
      ) {
        return { document };
      }
      const { doc: newModel } = detachBranch(document.model, activeNodeId);
      return {
        document: { ...document, model: newModel },
        focusId: landOnPredecessor(document.model, activeNodeId, newModel),
      };
    }

    case "replace":
      return { document: action.state.document };

    default:
      return assertNever(action);
  }
}

// --- View reducer ---

/**
 * The caret invariant: cursorPos and selectionEnd are offsets INTO
 * `editingText`, so they must lie within it.
 *
 * A caret cannot be checked where it enters. It arrives from the textarea —
 * `action.pos`, `action.cursorPos`, a drag's offsets — describing the
 * textarea's value at the moment of the event, while `editingText` is whatever
 * the case assigns; the two disagree whenever the document moved underneath
 * the buffer or the event raced the model. Cases building a view literal
 * directly (activateNode, dragSelect) bypass focusView and each had to
 * remember to bound the caret themselves; `setTitle` was the only one that did.
 *
 * Normalising on the way out instead makes the bound structural — a new case
 * cannot reintroduce the gap, because it never gets to return an unnormalised
 * view. The reducer has two exits and both apply it: the tail of editorReducer,
 * and reconcileView for the `replace` path that returns before it. Identity is
 * preserved when nothing is out of range, so a no-op still returns the same
 * reference.
 */
function sameIds(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Identity-preserving: only allocates when there was a selection to drop. */
function withoutSelection(view: ViewState): ViewState {
  return view.selectedIds === undefined ? view : { ...view, selectedIds: undefined };
}

function withCaretInBuffer(view: ViewState): ViewState {
  const len = view.editingText.length;
  const cursorPos = Math.min(Math.max(view.cursorPos, 0), len);
  const selectionEnd = Math.min(Math.max(view.selectionEnd, 0), len);
  if (cursorPos === view.cursorPos && selectionEnd === view.selectionEnd)
    return view;
  return { ...view, cursorPos, selectionEnd };
}

/**
 * Move focus to a node, resolving its text from the (new) document model.
 * Defaults the cursor to the end of the text. Preserves the current edit mode.
 */
/**
 * Update {@link ViewState.lastChildByParent} for a node that is about to take
 * the focus. Called from every focus path (focusView plus the click/drag
 * literals below) rather than only from `moveToParent`, so the memory records
 * wherever the user actually ended up in a branch — arrowing down through
 * siblings then pressing ← returns via → to the sibling they stopped on, not
 * to the one they entered from.
 *
 * Returns the existing record unchanged when nothing moves, keeping the object
 * identity stable so React sees no spurious change.
 */
function rememberChild(
  view: ViewState,
  model: MindMapDocument,
  nodeId: string
): ViewState["lastChildByParent"] {
  const loc = locateNode(model, nodeId);
  // A root has no parent to key on.
  if (!loc || loc.parent === null) return view.lastChildByParent;
  if (view.lastChildByParent[loc.parent.id] === nodeId)
    return view.lastChildByParent;
  return { ...view.lastChildByParent, [loc.parent.id]: nodeId };
}

function focusView(
  view: ViewState,
  model: MindMapDocument,
  nodeId: string,
  cursorPos?: number,
  selectionEnd?: number
): ViewState {
  const node = findNode(model, nodeId);
  const text = node?.text ?? "";
  const pos = cursorPos ?? text.length;
  const sel = selectionEnd ?? pos;
  return {
    activeNodeId: nodeId,
    // Keep the current mode: structural edits stay in edit mode, while
    // selection-mode navigation (move up/down) stays in selection mode.
    editing: view.editing,
    editingText: text,
    cursorPos: pos,
    selectionEnd: sel,
    lastChildByParent: rememberChild(view, model, nodeId),
  };
}

function viewReducer(
  view: ViewState,
  action: EditorAction,
  prevDocument: DocumentState,
  nextDocument: DocumentState,
  focusId: string | undefined,
  focusCursorPos: number | undefined,
  focusSelectionEnd: number | undefined
): ViewState {
  const model = nextDocument.model;

  switch (action.type) {
    // Actions that hand off a specific node to focus (new node or existing
    // landing node) via documentReducer's focusId.
    case "enter":
    case "backspaceAtStart":
    case "deleteAtEnd":
    case "cutBranch":
    case "pasteBranch":
    case "toggleCollapse":
    case "addChild":
    case "deleteNode":
    case "setNodeType":
    case "insertNodes":
    case "moveNodeUp":
    case "moveNodeDown":
    case "moveBranch":
    case "placeBranchAt":
      return focusId === undefined
        ? view
        : focusView(view, model, focusId, focusCursorPos, focusSelectionEnd);

    // Like the focus-handoff group above, but the newly created sibling is
    // handed straight into edit mode so its text can be typed immediately.
    case "insertSiblingAfter":
    case "addRootAt":
      return focusId === undefined
        ? view
        : {
            ...focusView(view, model, focusId, focusCursorPos, focusSelectionEnd),
            editing: true,
          };

    case "tab":
    case "setNodeStyle":
    case "setLinkMeta":
    case "setChecked":
    case "setCheckedMany":
    case "copyBranch":
      return view;

    case "setSelectedIds": {
      const ids = Array.from(new Set(action.ids)).filter(
        (nodeId) => findNode(model, nodeId) != null
      );
      const next = ids.length > 0 ? ids : undefined;
      if (sameIds(view.selectedIds, next)) return view;
      return { ...view, selectedIds: next };
    }

    case "moveUp":
    case "arrowLeftEdge": {
      if (!view.activeNodeId) return view;
      const order = getFlatOrder(model);
      const idx = order.indexOf(view.activeNodeId);
      if (idx > 0) return focusView(view, model, order[idx - 1]);
      return view;
    }

    case "moveDown": {
      if (!view.activeNodeId) return view;
      const order = getFlatOrder(model);
      const idx = order.indexOf(view.activeNodeId);
      if (idx < order.length - 1) return focusView(view, model, order[idx + 1]);
      return view;
    }

    case "moveUpSiblingFirst":
    case "moveDownSiblingFirst": {
      if (!view.activeNodeId) return view;
      const dir = action.type === "moveUpSiblingFirst" ? -1 : 1;
      const loc = locateNode(model, view.activeNodeId);
      if (!loc) return view;
      // THE RULE: these never descend into a node's children — going a level
      // deeper is → 's job. Otherwise "↓ on a parent" would mean one thing for
      // a node with a following sibling and another for the last child of a
      // branch (the flat order's next IS the first child), which is invisible
      // to the user and was exactly the bug this replaces.
      //
      // Siblings share a parent, so if the active node is visible they all are
      // — no collapsed check needed here (unlike moveToChild). The same holds
      // for the parent and for any ancestor's sibling below. The roots are
      // siblings of one another, so ↑/↓ on a root walks the trees in order.
      if (dir === -1) {
        const prev = loc.siblings[loc.index - 1];
        if (prev) return focusView(view, model, prev.id);
        // First child → the parent, which is what sits above it on the canvas.
        // The first root has nothing above it.
        if (loc.parent === null) return view;
        return focusView(view, model, loc.parent.id);
      }
      // Down: the next sibling, else climb until an ancestor has one — i.e.
      // step over the whole subtree we are in and land on the next thing at
      // any level. This runs out on the document's trailing edge: the last
      // root, its last child, ITS last child, and so on. Those nodes may still
      // have children (↓ just refuses to descend into them) — → is how you get
      // in.
      for (
        let at: ReturnType<typeof locateNode> = loc;
        at;
        at = at.parent ? locateNode(model, at.parent.id) : null
      ) {
        const next = at.siblings[at.index + 1];
        if (next) return focusView(view, model, next.id);
      }
      return view;
    }

    case "moveToParent": {
      if (!view.activeNodeId) return view;
      const loc = locateNode(model, view.activeNodeId);
      if (!loc || loc.parent === null) return view; // a root has no parent
      // Record the child we are LEAVING, not just the parent we arrive at.
      // rememberChild covers every path that navigated into the child, but
      // recording the departure here makes ← → a round-trip even when the
      // focus was placed on the child without passing through focusView.
      const leaving: ViewState = {
        ...view,
        lastChildByParent: {
          ...view.lastChildByParent,
          [loc.parent.id]: view.activeNodeId,
        },
      };
      return focusView(leaving, model, loc.parent.id);
    }

    case "moveToChild": {
      if (!view.activeNodeId) return view;
      const node = findNode(model, view.activeNodeId);
      if (!node || node.children.length === 0) return view;
      // Expanding a folded branch is the caller's job (the keymap does it, and
      // saves the resulting fold state); refuse rather than drop the focus on
      // a node the fold is hiding.
      if (node.collapsed) return view;
      // Return to where the user last was in this branch. The remembered id is
      // checked against the live children, so one that was deleted or moved
      // elsewhere silently falls back to the first child.
      const remembered = view.lastChildByParent[node.id];
      const target = node.children.some((c) => c.id === remembered)
        ? remembered
        : node.children[0].id;
      return focusView(view, model, target);
    }

    case "arrowRightEdge": {
      if (!view.activeNodeId) return view;
      const order = getFlatOrder(model);
      const idx = order.indexOf(view.activeNodeId);
      if (idx < order.length - 1)
        return focusView(view, model, order[idx + 1], 0, 0);
      return view;
    }

    case "cmdLeft": {
      if (!view.activeNodeId) return view;
      const order = getFlatOrder(model);
      const idx = order.indexOf(view.activeNodeId);
      if (action.pos === 0 && idx > 0) {
        // Already at start → jump to end of previous node
        return focusView(view, model, order[idx - 1]);
      }
      // Jump to start of current node
      if (view.cursorPos === 0 && view.selectionEnd === 0) return view;
      return { ...view, cursorPos: 0, selectionEnd: 0 };
    }

    case "cmdRight": {
      if (!view.activeNodeId) return view;
      const currentNode = findNode(model, view.activeNodeId);
      if (!currentNode) return view;
      const order = getFlatOrder(model);
      const idx = order.indexOf(view.activeNodeId);

      if (action.pos >= currentNode.text.length && idx < order.length - 1) {
        // Already at end → jump to start of next node
        return focusView(view, model, order[idx + 1], 0, 0);
      }
      const endPos = currentNode.text.length;
      if (view.cursorPos === endPos && view.selectionEnd === endPos)
        return view;
      return { ...view, cursorPos: endPos, selectionEnd: endPos };
    }

    case "cmdShiftLeft": {
      if (!view.activeNodeId) return view;
      // Extend selection to start of node (anchor stays at selEnd)
      return { ...view, cursorPos: 0, selectionEnd: action.selEnd };
    }

    case "cmdShiftRight": {
      if (!view.activeNodeId) return view;
      const currentNode = findNode(model, view.activeNodeId);
      if (!currentNode) return view;
      // Extend selection to end of node (anchor stays at pos)
      return {
        ...view,
        cursorPos: action.pos,
        selectionEnd: currentNode.text.length,
      };
    }

    case "typeText": {
      if (!view.activeNodeId) return view;
      return {
        ...view,
        // Typing always implies edit mode (covers typing on a selected node).
        editing: true,
        editingText: action.text,
        cursorPos: action.cursorPos,
        selectionEnd: action.selectionEnd,
      };
    }

    case "setSelection": {
      if (
        action.cursorPos === view.cursorPos &&
        action.selectionEnd === view.selectionEnd
      )
        return view;
      return {
        ...view,
        cursorPos: action.cursorPos,
        selectionEnd: action.selectionEnd,
      };
    }

    case "activateNode": {
      const node = findNode(model, action.nodeId);
      if (!node) return view;
      return {
        activeNodeId: action.nodeId,
        editing: action.editing,
        editingText: node.text,
        cursorPos: action.cursorPos,
        selectionEnd: action.selectionEnd,
        lastChildByParent: rememberChild(view, model, action.nodeId),
      };
    }

    case "startEditing": {
      if (!view.activeNodeId) return view;
      const node = findNode(model, view.activeNodeId);
      if (!node) return view;
      return {
        ...view,
        editing: true,
        editingText: node.text,
        cursorPos: action.cursorPos ?? 0,
        selectionEnd: action.selectionEnd ?? node.text.length,
      };
    }

    case "exitEditing": {
      if (!view.activeNodeId || !view.editing) return view;
      // A blank leaf node was deleted on exit: focus the landing node in
      // selection mode instead of the now-gone node.
      if (focusId !== undefined) {
        return { ...focusView(view, model, focusId), editing: false };
      }
      const node = findNode(model, view.activeNodeId);
      const len = node?.text.length ?? 0;
      return {
        ...view,
        editing: false,
        // Back to selection mode: select the whole text so a follow-up keypress
        // replaces it, matching the just-selected-node behaviour.
        cursorPos: 0,
        selectionEnd: len,
      };
    }

    case "selectAllInNode": {
      const node = findNode(model, action.nodeId);
      if (!node) return view;
      return {
        activeNodeId: action.nodeId,
        editing: true,
        editingText: node.text,
        cursorPos: 0,
        selectionEnd: node.text.length,
        lastChildByParent: rememberChild(view, model, action.nodeId),
      };
    }

    case "dragSelect": {
      const node = findNode(model, action.nodeId);
      if (!node) return view;
      // Dragging within a node selects a text range, which is an editing gesture.
      const start = Math.min(action.anchorOffset, action.focusOffset);
      const end = Math.max(action.anchorOffset, action.focusOffset);
      return {
        activeNodeId: action.nodeId,
        editing: true,
        editingText: node.text,
        cursorPos: start,
        selectionEnd: end,
        lastChildByParent: rememberChild(view, model, action.nodeId),
      };
    }

    case "setNodeContent": {
      if (focusId !== undefined) {
        // documentReducer only supplies focusId here when the change hid the
        // previously-active node; land on it like the generic focus-handoff
        // group above.
        return focusView(view, model, focusId, focusCursorPos, focusSelectionEnd);
      }
      if (view.activeNodeId !== action.nodeId) return view;
      // Mirrors documentReducer's own node-exists guard.
      if (nextDocument.model === prevDocument.model) return view;
      return {
        ...view,
        editingText: action.text,
        cursorPos: action.text.length,
        selectionEnd: action.text.length,
      };
    }

    case "setTitle":
      return view; // the title is not a node; the selection is untouched

    case "replace":
      return view; // handled directly by editorReducer

    default:
      return assertNever(action);
  }
}

/**
 * Reconciles a ViewState against a DocumentState it wasn't derived from —
 * needed after undo/redo, which restores only the document (see
 * UndoManager). If the active node no longer exists in the restored
 * document (it was created/removed by the undone/redone edit), the active
 * id would dangle and silently no-op every subsequent keyboard action. A
 * node that still exists but is hidden (the undone edit was the expand that
 * revealed it) is just as unusable: the view lands on the collapsed ancestor.
 *
 * `prevDocument` is the document the stale view *was* derived from (i.e. the
 * pre-undo/redo document). When given, we locate the vanished node in its
 * flat order and land on the nearest surviving neighbour — preferring the
 * previous node, then the next — mirroring deleteNode's refocus behaviour so
 * selection stays close to where the user was. Without it (or when no
 * neighbour survives) we fall back to the first top-level node.
 *
 * A node that survived the swap needs reconciling too, in the text: the view
 * carries `editingText`, the textarea's value, and undo restores the document
 * *under* it. Left alone, the textarea keeps showing the pre-undo text — ⌘Z
 * visibly does nothing to the node being edited — and the next keystroke
 * commits that buffer back through typeText, silently undoing the undo. So the
 * buffer is re-read from the restored node and the caret is kept where it was,
 * clamped into the text that is actually there now.
 *
 * The one buffer that is *meant* to run ahead of the model — an uncommitted IME
 * composition — is not excepted here, because composition is not in ViewState.
 * It does not have to be: both editors' onKeyDown returns while isComposing, so
 * no undo/redo can be dispatched mid-composition in the first place.
 */
export function reconcileView(
  view: ViewState,
  document: DocumentState,
  prevDocument?: DocumentState
): ViewState {
  const visible = new Set(getFlatOrder(document.model));
  if (view.activeNodeId && visible.has(view.activeNodeId)) {
    const text = findNode(document.model, view.activeNodeId)!.text;
    return withCaretInBuffer(
      text === view.editingText ? view : { ...view, editingText: text }
    );
  }
  // Existing but hidden — the document swap (undo of an expand, say) folded
  // an ancestor over the active node. Land on the ancestor that hides it,
  // as toggleCollapse does. Otherwise the node is gone: nearest survivor.
  const landId =
    view.activeNodeId && findNode(document.model, view.activeNodeId)
      ? nearestVisibleAncestor(document.model, view.activeNodeId, visible)
      : findNearestSurvivor(view.activeNodeId, document, prevDocument);
  return focusView(
    { ...view, editing: false },
    document.model,
    landId,
    0,
    0
  );
}

function nearestVisibleAncestor(
  model: MindMapDocument,
  nodeId: string,
  visible: Set<string>
): string {
  for (let loc = locateNode(model, nodeId); loc?.parent; loc = locateNode(model, loc.parent.id)) {
    if (visible.has(loc.parent.id)) return loc.parent.id;
  }
  return firstRootId(model);
}

/**
 * Given a node that vanished from `document`, find the nearest node in
 * `prevDocument`'s flat order that still exists in `document`. Walks outward
 * from the vanished node's position, previous side first. Returns the first
 * root when there's no prior order or no neighbour survives.
 */
function findNearestSurvivor(
  vanishedId: string | null,
  document: DocumentState,
  prevDocument?: DocumentState
): string {
  const rootId = firstRootId(document.model);
  if (!vanishedId || !prevDocument) return rootId;
  const order = getFlatOrder(prevDocument.model);
  const idx = order.indexOf(vanishedId);
  if (idx === -1) return rootId;
  // Expand outward: idx-1, idx+1, idx-2, idx+2, … so the previous node wins
  // ties, matching deleteNode's "land on the predecessor" preference.
  for (let step = 1; step < order.length; step++) {
    const prev = order[idx - step];
    if (prev && findNode(document.model, prev)) return prev;
    const next = order[idx + step];
    if (next && findNode(document.model, next)) return next;
  }
  return rootId;
}

// --- Reducer ---

export function editorReducer(
  state: EditorState,
  action: EditorAction,
  nextId: IdSource = generateId
): EditorState {
  if (action.type === "replace") {
    // Undo/redo (and any wholesale document swap) route through `replace`.
    // Reconcile the incoming view against its document here so the invariant
    // "the active node always exists" is enforced by the reducer itself —
    // never left as a rule each caller must remember to apply. Idempotent: a
    // view that already points to a live node is returned unchanged.
    const view = withoutSelection(
      reconcileView(action.state.view, action.state.document, state.document)
    );
    if (view === action.state.view) return action.state;
    return { document: action.state.document, view };
  }

  const docResult = documentReducer(
    state.document,
    action,
    state.view,
    nextId
  );
  // The document must always keep a root (with none there'd be nothing to
  // select). Deleting or cutting the last one replaces it with a blank root
  // that takes the focus.
  if (docResult.document.model.roots.length === 0) {
    const model = ensureRoot(docResult.document.model, nextId);
    docResult.document = { ...docResult.document, model };
    docResult.focusId = firstRootId(model);
  }
  let nextView = withCaretInBuffer(
    viewReducer(
      state.view,
      action,
      state.document,
      docResult.document,
      docResult.focusId,
      docResult.focusCursorPos,
      docResult.focusSelectionEnd
    )
  );
  // setSelectedIds is the only action that MEANS to set selectedIds, and
  // setCheckedMany acts ON the current selection rather than replacing it
  // (see ViewState.selectedIds' doc comment) — every other action clears it,
  // enforced here once rather than in each of the ~40 cases above, so a new
  // action can't forget to and leave a stale multi-selection behind.
  if (action.type !== "setSelectedIds" && action.type !== "setCheckedMany") {
    nextView = withoutSelection(nextView);
  }

  if (docResult.document === state.document && nextView === state.view) {
    return state;
  }
  return { document: docResult.document, view: nextView };
}
