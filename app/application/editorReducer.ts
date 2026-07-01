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
  removeNode,
  detachBranch,
  cloneWithNewIds,
  indentNode,
  dedentNode,
  splitNode,
  updateNodeText,
  toggleCollapse,
  addChildToNode,
  setNodeType,
  setNodeStyle,
  setLinkMeta,
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
  // --- navigation ---
  | { type: "moveUp" }
  | { type: "moveDown" }
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
  | {
      type: "dragSelect";
      anchorNodeId: string;
      anchorOffset: number;
      focusNodeId: string;
      focusOffset: number;
    }
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
      const result = splitNode(model, activeNodeId, action.pos);
      return {
        document: { ...document, model: result.model },
        focusId: result.newNodeId,
        // Caret lands at the start of the split-off text, not its end.
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

    case "backspaceAtStart": {
      if (!activeNodeId) return { document };
      const { model } = document;
      const currentNode = findNode(model, activeNodeId);
      if (!currentNode) return { document };

      const order = getFlatOrder(model);
      const idx = order.indexOf(activeNodeId);

      if (currentNode.text === "" && model.id !== activeNodeId) {
        const newModel = removeNode(model, activeNodeId);
        const landId = idx > 0 ? order[idx - 1] : newModel.id;
        return { document: { ...document, model: newModel }, focusId: landId };
      }

      if (idx > 0 && model.id !== activeNodeId) {
        const prevId = order[idx - 1];
        const prevNode = findNode(model, prevId);
        if (prevNode) {
          const mergePos = prevNode.text.length;
          const mergedText = prevNode.text + currentNode.text;
          let newModel = updateNodeText(model, prevId, mergedText);
          newModel = removeNode(newModel, activeNodeId);
          return {
            document: { ...document, model: newModel },
            focusId: prevId,
            // Caret lands at the merge boundary, not the end of the merged text.
            focusCursorPos: mergePos,
            focusSelectionEnd: mergePos,
          };
        }
      }

      return { document };
    }

    case "deleteAtEnd": {
      if (!activeNodeId) return { document };
      const { model } = document;
      const currentNode = findNode(model, activeNodeId);
      if (!currentNode) return { document };

      const order = getFlatOrder(model);
      const idx = order.indexOf(activeNodeId);

      if (action.pos >= currentNode.text.length && idx < order.length - 1) {
        const nextId = order[idx + 1];
        const nextNode = findNode(model, nextId);
        if (nextNode) {
          const mergedText = currentNode.text + nextNode.text;
          let newModel = updateNodeText(model, activeNodeId, mergedText);
          newModel = removeNode(newModel, nextId);
          return { document: { ...document, model: newModel } };
        }
      }

      return { document };
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
      const newModel = removeNode(document.model, action.nodeId);
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
      return focusId === undefined
        ? view
        : focusView(view, model, focusId, focusCursorPos, focusSelectionEnd);

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
      const focusNode = findNode(model, action.focusNodeId);
      if (!focusNode) return view;
      if (action.focusNodeId === action.anchorNodeId) {
        // Same node: dragging selects a text range, which is an editing gesture.
        const start = Math.min(action.anchorOffset, action.focusOffset);
        const end = Math.max(action.anchorOffset, action.focusOffset);
        return {
          activeNodeId: action.focusNodeId,
          editing: true,
          editingText: focusNode.text,
          cursorPos: start,
          selectionEnd: end,
        };
      }
      // Cross-node drag: just move focus to the dragged-over node (no
      // multi-node selection).
      return {
        activeNodeId: action.focusNodeId,
        editing: false,
        editingText: focusNode.text,
        cursorPos: action.focusOffset,
        selectionEnd: action.focusOffset,
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

// --- Reducer ---

export function editorReducer(
  state: EditorState,
  action: EditorAction
): EditorState {
  if (action.type === "replace") return action.state;

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
