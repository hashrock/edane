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
 * selectionEnd. There is no multi-node selection.
 */

import type { MindMapModel, NodeType } from "../domain/model";
import {
  findNode,
  findParentAndIndex,
  getFlatOrder,
  generateId,
  cloneModel,
  addSiblingAfter,
  detachBranch,
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
  setLinkMeta,
  moveNodeUp,
  moveNodeDown,
  moveBranch,
} from "../domain/model";

export interface DocumentState {
  model: MindMapModel;
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
}

export interface EditorState {
  document: DocumentState;
  view: ViewState;
}

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
  // --- navigation ---
  | { type: "moveUp" }
  | { type: "moveDown" }
  // Move focus to the active node's parent (Left in selection mode on a leaf /
  // collapsed node).
  | { type: "moveToParent" }
  | { type: "cmdLeft"; pos: number }
  | { type: "cmdRight"; pos: number }
  | { type: "cmdShiftLeft"; pos: number; selEnd: number }
  | { type: "cmdShiftRight"; pos: number; selEnd: number }
  | { type: "arrowLeftEdge" }
  | { type: "arrowRightEdge" }
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
  | { type: "pasteBranch" }
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
  // Insert an empty sibling right after the active node and edit it (Enter in
  // selection mode). Falls back to a child when the root is active.
  | { type: "insertSiblingAfter" }
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
  activeNodeId: string | null
): DocumentResult {
  switch (action.type) {
    case "enter": {
      if (!activeNodeId) return { document };
      const { model } = document;
      const currentNode = findNode(model, activeNodeId);
      if (!currentNode) return { document };

      if (action.pos >= currentNode.text.length) {
        const newId = generateId();
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
        const result = splitNode(model, activeNodeId, 0);
        return {
          document: { ...document, model: result.model },
          focusId: activeNodeId,
          focusCursorPos: 0,
          focusSelectionEnd: 0,
        };
      }

      // Mid-text split: the prefix stays on this node (keeps its id + children),
      // the suffix becomes a following sibling; the caret lands at its start.
      const result = splitNode(model, activeNodeId, action.pos);
      return {
        document: { ...document, model: result.model },
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
      // Expand a collapsed drop target so the moved node stays visible.
      const parent = findNode(moved, action.newParentId);
      const newModel = parent?.collapsed
        ? toggleCollapse(moved, action.newParentId, false)
        : moved;
      return {
        document: { ...document, model: newModel },
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
        document: { ...document, model: merged.model },
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
      return { document: { ...document, model: newModel } };
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
      if (!activeNodeId || activeNodeId === model.id) return { document }; // never cut root
      const order = getFlatOrder(model);
      const idx = order.indexOf(activeNodeId);
      const { model: newModel, removed } = detachBranch(model, activeNodeId);
      if (!removed) return { document };
      const prevId = idx > 0 ? order[idx - 1] : null;
      const landId =
        prevId && findNode(newModel, prevId) ? prevId : newModel.id;
      return {
        document: { model: newModel, clipboard: removed },
        focusId: landId,
      };
    }

    case "pasteBranch": {
      const { model, clipboard } = document;
      if (!activeNodeId || !clipboard) return { document };
      const target = findNode(model, activeNodeId);
      if (!target) return { document };
      const fresh = cloneWithNewIds(clipboard);
      // Expand the target so the pasted child is visible, then append it.
      let newModel = toggleCollapse(model, activeNodeId, false);
      newModel = addChildToNode(newModel, activeNodeId, fresh);
      // Keep the clipboard so the branch can be pasted again.
      return {
        document: { model: newModel, clipboard },
        focusId: fresh.id,
      };
    }

    case "insertNodes": {
      const { targetId, nodes } = action;
      if (nodes.length === 0) return { document };
      const newModel = cloneModel(document.model);
      const parentInfo = findParentAndIndex(newModel, targetId);
      if (parentInfo) {
        parentInfo.parent.children.splice(parentInfo.index + 1, 0, ...nodes);
      } else {
        const root = findNode(newModel, targetId);
        if (!root) return { document };
        root.children.push(...nodes);
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
      if (!activeNodeId) return { document };
      const newId = generateId();
      const newNode: MindMapModel = { id: newId, text: "", children: [] };
      return {
        document: {
          ...document,
          model: addSiblingAfter(document.model, activeNodeId, newNode),
        },
        focusId: newId,
      };
    }

    case "addChild": {
      const parent = findNode(document.model, action.nodeId);
      if (!parent) return { document };
      const newId = generateId();
      const newNode: MindMapModel = { id: newId, text: "", children: [] };
      // Expand first so the new child is visible, then append it.
      let newModel = toggleCollapse(document.model, action.nodeId, false);
      newModel = addChildToNode(newModel, action.nodeId, newNode);
      return { document: { ...document, model: newModel }, focusId: newId };
    }

    case "deleteNode": {
      if (action.nodeId === document.model.id) return { document }; // never delete root
      const order = getFlatOrder(document.model);
      const idx = order.indexOf(action.nodeId);
      // Delete the node together with its WHOLE subtree (children are removed,
      // not promoted to the parent level).
      const { model: newModel, removed } = detachBranch(
        document.model,
        action.nodeId
      );
      if (removed === null) return { document }; // root (or unknown) → no-op
      const newDocument = { ...document, model: newModel };
      // Only refocus if the currently active node disappeared.
      if (activeNodeId && !findNode(newModel, activeNodeId)) {
        const prevId = idx > 0 ? order[idx - 1] : null;
        const landId =
          prevId && findNode(newModel, prevId) ? prevId : newModel.id;
        return { document: newDocument, focusId: landId };
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
      return { document: { ...document, model: newModel } };
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

    case "setTitle": {
      const nextModel = updateNodeText(
        document.model,
        document.model.id,
        action.text
      );
      return { document: { ...document, model: nextModel } };
    }

    // Pure view actions: the document never changes.
    case "moveUp":
    case "moveDown":
    case "moveToParent":
    case "cmdLeft":
    case "cmdRight":
    case "cmdShiftLeft":
    case "cmdShiftRight":
    case "arrowLeftEdge":
    case "arrowRightEdge":
    case "setSelection":
    case "activateNode":
    case "startEditing":
    case "exitEditing":
    case "selectAllInNode":
    case "dragSelect":
      return { document };

    case "replace":
      return { document: action.state.document };
  }
}

// --- View reducer ---

/**
 * Move focus to a node, resolving its text from the (new) document model.
 * Defaults the cursor to the end of the text. Preserves the current edit mode.
 */
function focusView(
  view: ViewState,
  model: MindMapModel,
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
      return focusId === undefined
        ? view
        : focusView(view, model, focusId, focusCursorPos, focusSelectionEnd);

    // Like the focus-handoff group above, but the newly created sibling is
    // handed straight into edit mode so its text can be typed immediately.
    case "insertSiblingAfter":
      return focusId === undefined
        ? view
        : {
            ...focusView(view, model, focusId, focusCursorPos, focusSelectionEnd),
            editing: true,
          };

    case "tab":
    case "setNodeStyle":
    case "setLinkMeta":
    case "copyBranch":
      return view;

    case "deleteAtEnd": {
      // Mirrors documentReducer's own merge guard: no model change means no
      // merge happened, so the caret doesn't move.
      if (nextDocument.model === prevDocument.model) return view;
      return { ...view, cursorPos: action.pos, selectionEnd: action.pos };
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

    case "moveToParent": {
      if (!view.activeNodeId) return view;
      const info = findParentAndIndex(model, view.activeNodeId);
      if (!info) return view; // root has no parent
      return focusView(view, model, info.parent.id);
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
      };
    }

    case "setNodeContent": {
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

    case "setTitle": {
      if (view.activeNodeId !== prevDocument.model.id) return view;
      const clamp = (pos: number) => Math.min(pos, action.text.length);
      return {
        ...view,
        editingText: action.text,
        cursorPos: clamp(view.cursorPos),
        selectionEnd: clamp(view.selectionEnd),
      };
    }

    case "replace":
      return view; // handled directly by editorReducer
  }
}

/**
 * Reconciles a ViewState against a DocumentState it wasn't derived from —
 * needed after undo/redo, which restores only the document (see
 * UndoManager). If the active node no longer exists in the restored
 * document (it was created/removed by the undone/redone edit), the active
 * id would dangle and silently no-op every subsequent keyboard action.
 *
 * `prevDocument` is the document the stale view *was* derived from (i.e. the
 * pre-undo/redo document). When given, we locate the vanished node in its
 * flat order and land on the nearest surviving neighbour — preferring the
 * previous node, then the next — mirroring deleteNode's refocus behaviour so
 * selection stays close to where the user was. Without it (or when no
 * neighbour survives) we fall back to the document root.
 */
export function reconcileView(
  view: ViewState,
  document: DocumentState,
  prevDocument?: DocumentState
): ViewState {
  if (view.activeNodeId && findNode(document.model, view.activeNodeId)) {
    return view;
  }
  const landId = findNearestSurvivor(view.activeNodeId, document, prevDocument);
  return focusView(
    { ...view, editing: false },
    document.model,
    landId,
    0,
    0
  );
}

/**
 * Given a node that vanished from `document`, find the nearest node in
 * `prevDocument`'s flat order that still exists in `document`. Walks outward
 * from the vanished node's position, previous side first. Returns the
 * document root when there's no prior order or no neighbour survives.
 */
function findNearestSurvivor(
  vanishedId: string | null,
  document: DocumentState,
  prevDocument?: DocumentState
): string {
  const rootId = document.model.id;
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
  action: EditorAction
): EditorState {
  if (action.type === "replace") {
    // Undo/redo (and any wholesale document swap) route through `replace`.
    // Reconcile the incoming view against its document here so the invariant
    // "the active node always exists" is enforced by the reducer itself —
    // never left as a rule each caller must remember to apply. Idempotent: a
    // view that already points to a live node is returned unchanged.
    const view = reconcileView(
      action.state.view,
      action.state.document,
      state.document
    );
    if (view === action.state.view) return action.state;
    return { document: action.state.document, view };
  }

  const docResult = documentReducer(
    state.document,
    action,
    state.view.activeNodeId
  );
  const nextView = viewReducer(
    state.view,
    action,
    state.document,
    docResult.document,
    docResult.focusId,
    docResult.focusCursorPos,
    docResult.focusSelectionEnd
  );

  if (docResult.document === state.document && nextView === state.view) {
    return state;
  }
  return { document: docResult.document, view: nextView };
}
