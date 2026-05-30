/**
 * Application layer: editor state reducer.
 *
 * Single source of truth (EditorState) reduced by EditorAction.
 * The reducer is pure (no React/DOM) and always returns a COMPLETE next
 * state. A no-op action returns the SAME state reference, which lets the
 * caller cheaply skip re-rendering / undo bookkeeping.
 */

import type { MindMapModel } from "../domain/model";
import {
  findNode,
  findParentAndIndex,
  getFlatOrder,
  generateId,
  cloneModel,
  addSiblingAfter,
  removeNode,
  indentNode,
  dedentNode,
  splitNode,
  updateNodeText,
  deleteNodeRange,
} from "../domain/model";

export interface EditorState {
  model: MindMapModel;
  activeNodeId: string | null;
  editingText: string;
  cursorPos: number;
  selectionEnd: number;
  // Multi-node selection anchor (null = no separate anchor / single caret)
  selAnchorNodeId: string | null;
  selAnchorOffset: number;
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
  // --- range selection collapse ---
  | { type: "collapseSelection" }
  | { type: "collapseSelectionAndInsert"; char: string }
  // --- pointer ---
  | {
      type: "activateNode";
      nodeId: string;
      cursorPos: number;
      selectionEnd: number;
      anchorNodeId: string | null;
      anchorOffset: number;
    }
  | { type: "selectAllInNode"; nodeId: string }
  | {
      type: "dragSelect";
      anchorNodeId: string;
      anchorOffset: number;
      focusNodeId: string;
      focusOffset: number;
    }
  | { type: "deselect" }
  // --- bulk / misc ---
  | { type: "insertNodes"; targetId: string; nodes: MindMapModel[] }
  | { type: "setTitle"; text: string }
  | { type: "replace"; state: EditorState };

// --- Selection predicates ---

export function isMultiNodeSelection(state: EditorState): boolean {
  return (
    state.selAnchorNodeId !== null &&
    state.selAnchorNodeId !== state.activeNodeId
  );
}

export function hasAnySelection(state: EditorState): boolean {
  return isMultiNodeSelection(state) || state.cursorPos !== state.selectionEnd;
}

// --- Helpers ---

/**
 * Move focus to a node, resolving its text from the model. Defaults the
 * cursor to the end of the text and clears any multi-node anchor.
 */
function focusNodeState(
  state: EditorState,
  model: MindMapModel,
  nodeId: string,
  cursorPos?: number,
  selectionEnd?: number
): EditorState {
  const node = findNode(model, nodeId);
  const text = node?.text ?? "";
  const pos = cursorPos ?? text.length;
  const sel = selectionEnd ?? pos;
  return {
    model,
    activeNodeId: nodeId,
    editingText: text,
    cursorPos: pos,
    selectionEnd: sel,
    selAnchorNodeId: null,
    selAnchorOffset: 0,
  };
}

// --- Reducer ---

export function editorReducer(
  state: EditorState,
  action: EditorAction
): EditorState {
  switch (action.type) {
    case "enter": {
      const { model, activeNodeId } = state;
      if (!activeNodeId) return state;
      const currentNode = findNode(model, activeNodeId);
      if (!currentNode) return state;

      if (action.pos >= currentNode.text.length) {
        // At end: add empty sibling
        const newId = generateId();
        const newNode: MindMapModel = { id: newId, text: "", children: [] };
        return {
          ...state,
          model: addSiblingAfter(model, activeNodeId, newNode),
          activeNodeId: newId,
          editingText: "",
          cursorPos: 0,
          selectionEnd: 0,
          selAnchorNodeId: null,
          selAnchorOffset: 0,
        };
      }
      // Mid-text: split node
      const textAfter = currentNode.text.substring(action.pos);
      const result = splitNode(model, activeNodeId, action.pos);
      return {
        ...state,
        model: result.model,
        activeNodeId: result.newNodeId,
        editingText: textAfter,
        cursorPos: 0,
        selectionEnd: 0,
        selAnchorNodeId: null,
        selAnchorOffset: 0,
      };
    }

    case "tab": {
      const { model, activeNodeId } = state;
      if (!activeNodeId) return state;
      const newModel = action.shift
        ? dedentNode(model, activeNodeId)
        : indentNode(model, activeNodeId);
      return { ...state, model: newModel };
    }

    case "backspaceAtStart": {
      const { model, activeNodeId } = state;
      if (!activeNodeId) return state;
      const currentNode = findNode(model, activeNodeId);
      if (!currentNode) return state;

      const order = getFlatOrder(model);
      const idx = order.indexOf(activeNodeId);

      if (currentNode.text === "" && model.id !== activeNodeId) {
        // Empty node: delete it, move to previous
        const newModel = removeNode(model, activeNodeId);
        if (idx > 0) {
          return focusNodeState(state, newModel, order[idx - 1]);
        }
        return {
          ...state,
          model: newModel,
          activeNodeId: null,
          selAnchorNodeId: null,
          selAnchorOffset: 0,
        };
      }

      if (idx > 0 && model.id !== activeNodeId) {
        // Non-empty at pos 0: merge with previous node
        const prevId = order[idx - 1];
        const prevNode = findNode(model, prevId);
        if (prevNode) {
          const mergePos = prevNode.text.length;
          const mergedText = prevNode.text + currentNode.text;
          let newModel = updateNodeText(model, prevId, mergedText);
          newModel = removeNode(newModel, activeNodeId);
          return {
            ...state,
            model: newModel,
            activeNodeId: prevId,
            editingText: mergedText,
            cursorPos: mergePos,
            selectionEnd: mergePos,
            selAnchorNodeId: null,
            selAnchorOffset: 0,
          };
        }
      }

      return state;
    }

    case "deleteAtEnd": {
      const { model, activeNodeId } = state;
      if (!activeNodeId) return state;
      const currentNode = findNode(model, activeNodeId);
      if (!currentNode) return state;

      const order = getFlatOrder(model);
      const idx = order.indexOf(activeNodeId);

      if (action.pos >= currentNode.text.length && idx < order.length - 1) {
        const nextId = order[idx + 1];
        const nextNode = findNode(model, nextId);
        if (nextNode) {
          const mergedText = currentNode.text + nextNode.text;
          let newModel = updateNodeText(model, activeNodeId, mergedText);
          newModel = removeNode(newModel, nextId);
          return {
            ...state,
            model: newModel,
            editingText: mergedText,
            cursorPos: action.pos,
            selectionEnd: action.pos,
          };
        }
      }

      return state;
    }

    case "moveUp": {
      const { model, activeNodeId } = state;
      if (!activeNodeId) return state;
      const order = getFlatOrder(model);
      const idx = order.indexOf(activeNodeId);
      if (idx > 0) return focusNodeState(state, model, order[idx - 1]);
      return state;
    }

    case "moveDown": {
      const { model, activeNodeId } = state;
      if (!activeNodeId) return state;
      const order = getFlatOrder(model);
      const idx = order.indexOf(activeNodeId);
      if (idx < order.length - 1)
        return focusNodeState(state, model, order[idx + 1]);
      return state;
    }

    case "cmdLeft": {
      const { model, activeNodeId } = state;
      if (!activeNodeId) return state;
      const order = getFlatOrder(model);
      const idx = order.indexOf(activeNodeId);
      if (action.pos === 0 && idx > 0) {
        // Already at start → jump to end of previous node
        return focusNodeState(state, model, order[idx - 1]);
      }
      // Jump to start of current node
      if (state.cursorPos === 0 && state.selectionEnd === 0) return state;
      return { ...state, cursorPos: 0, selectionEnd: 0 };
    }

    case "cmdRight": {
      const { model, activeNodeId } = state;
      if (!activeNodeId) return state;
      const currentNode = findNode(model, activeNodeId);
      if (!currentNode) return state;
      const order = getFlatOrder(model);
      const idx = order.indexOf(activeNodeId);

      if (action.pos >= currentNode.text.length && idx < order.length - 1) {
        // Already at end → jump to start of next node
        return focusNodeState(state, model, order[idx + 1], 0, 0);
      }
      const endPos = currentNode.text.length;
      if (state.cursorPos === endPos && state.selectionEnd === endPos)
        return state;
      return { ...state, cursorPos: endPos, selectionEnd: endPos };
    }

    case "cmdShiftLeft": {
      if (!state.activeNodeId) return state;
      // Extend selection to start of node (anchor stays at selEnd)
      return { ...state, cursorPos: 0, selectionEnd: action.selEnd };
    }

    case "cmdShiftRight": {
      const { model, activeNodeId } = state;
      if (!activeNodeId) return state;
      const currentNode = findNode(model, activeNodeId);
      if (!currentNode) return state;
      // Extend selection to end of node (anchor stays at pos)
      return {
        ...state,
        cursorPos: action.pos,
        selectionEnd: currentNode.text.length,
      };
    }

    case "arrowLeftEdge": {
      const { model, activeNodeId } = state;
      if (!activeNodeId) return state;
      const order = getFlatOrder(model);
      const idx = order.indexOf(activeNodeId);
      if (idx > 0) return focusNodeState(state, model, order[idx - 1]);
      return state;
    }

    case "arrowRightEdge": {
      const { model, activeNodeId } = state;
      if (!activeNodeId) return state;
      const order = getFlatOrder(model);
      const idx = order.indexOf(activeNodeId);
      if (idx < order.length - 1)
        return focusNodeState(state, model, order[idx + 1], 0, 0);
      return state;
    }

    case "typeText": {
      const { activeNodeId } = state;
      if (!activeNodeId) return state;
      const model =
        action.commitModel && activeNodeId
          ? updateNodeText(state.model, activeNodeId, action.text)
          : state.model;
      return {
        ...state,
        model,
        editingText: action.text,
        cursorPos: action.cursorPos,
        selectionEnd: action.selectionEnd,
        selAnchorNodeId: null,
        selAnchorOffset: 0,
      };
    }

    case "setSelection": {
      if (
        action.cursorPos === state.cursorPos &&
        action.selectionEnd === state.selectionEnd
      )
        return state;
      return {
        ...state,
        cursorPos: action.cursorPos,
        selectionEnd: action.selectionEnd,
      };
    }

    case "collapseSelection": {
      const { model, activeNodeId, selAnchorNodeId, selAnchorOffset, cursorPos } =
        state;
      if (!activeNodeId || !selAnchorNodeId || selAnchorNodeId === activeNodeId)
        return state;
      const {
        model: newModel,
        cursorNodeId,
        cursorOffset,
      } = deleteNodeRange(
        model,
        selAnchorNodeId,
        selAnchorOffset,
        activeNodeId,
        cursorPos
      );
      const node = findNode(newModel, cursorNodeId);
      return {
        ...state,
        model: newModel,
        activeNodeId: cursorNodeId,
        editingText: node?.text ?? "",
        cursorPos: cursorOffset,
        selectionEnd: cursorOffset,
        selAnchorNodeId: null,
        selAnchorOffset: 0,
      };
    }

    case "collapseSelectionAndInsert": {
      // Collapse the multi-node range first, then insert the typed char.
      const collapsed = editorReducer(state, { type: "collapseSelection" });
      const nodeId = collapsed.activeNodeId;
      if (!nodeId) return collapsed;
      const node = findNode(collapsed.model, nodeId);
      if (!node) return collapsed;
      const cPos = collapsed.cursorPos;
      const newText =
        node.text.substring(0, cPos) + action.char + node.text.substring(cPos);
      return {
        ...collapsed,
        model: updateNodeText(collapsed.model, nodeId, newText),
        editingText: newText,
        cursorPos: cPos + 1,
        selectionEnd: cPos + 1,
      };
    }

    case "activateNode": {
      const node = findNode(state.model, action.nodeId);
      if (!node) return state;
      return {
        ...state,
        activeNodeId: action.nodeId,
        editingText: node.text,
        cursorPos: action.cursorPos,
        selectionEnd: action.selectionEnd,
        selAnchorNodeId: action.anchorNodeId,
        selAnchorOffset: action.anchorOffset,
      };
    }

    case "selectAllInNode": {
      const node = findNode(state.model, action.nodeId);
      if (!node) return state;
      return {
        ...state,
        activeNodeId: action.nodeId,
        editingText: node.text,
        cursorPos: 0,
        selectionEnd: node.text.length,
        selAnchorNodeId: null,
        selAnchorOffset: 0,
      };
    }

    case "dragSelect": {
      const focusNode = findNode(state.model, action.focusNodeId);
      if (!focusNode) return state;
      if (action.focusNodeId === action.anchorNodeId) {
        // Single-node selection: highlight char range within the node
        const start = Math.min(action.anchorOffset, action.focusOffset);
        const end = Math.max(action.anchorOffset, action.focusOffset);
        return {
          ...state,
          activeNodeId: action.focusNodeId,
          editingText: focusNode.text,
          cursorPos: start,
          selectionEnd: end,
          selAnchorNodeId: action.anchorNodeId,
          selAnchorOffset: action.anchorOffset,
        };
      }
      // Multi-node selection: focus moves to the dragged-over node
      return {
        ...state,
        activeNodeId: action.focusNodeId,
        editingText: focusNode.text,
        cursorPos: action.focusOffset,
        selectionEnd: action.focusOffset,
        selAnchorNodeId: action.anchorNodeId,
        selAnchorOffset: action.anchorOffset,
      };
    }

    case "deselect": {
      if (state.activeNodeId === null && state.selAnchorNodeId === null)
        return state;
      return {
        ...state,
        activeNodeId: null,
        selAnchorNodeId: null,
        selAnchorOffset: 0,
      };
    }

    case "insertNodes": {
      const { targetId, nodes } = action;
      if (nodes.length === 0) return state;
      const newModel = cloneModel(state.model);
      const parentInfo = findParentAndIndex(newModel, targetId);
      if (parentInfo) {
        parentInfo.parent.children.splice(parentInfo.index + 1, 0, ...nodes);
      } else {
        const root = findNode(newModel, targetId);
        if (!root) return state;
        root.children.push(...nodes);
      }
      const last = nodes[nodes.length - 1];
      return {
        ...state,
        model: newModel,
        activeNodeId: last.id,
        editingText: last.text,
        cursorPos: last.text.length,
        selectionEnd: last.text.length,
        selAnchorNodeId: null,
        selAnchorOffset: 0,
      };
    }

    case "setTitle": {
      return {
        ...state,
        model: updateNodeText(state.model, state.model.id, action.text),
      };
    }

    case "replace": {
      return action.state;
    }
  }
}
