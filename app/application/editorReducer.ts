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
  // --- keyboard multi-node selection (Shift+Arrow) ---
  | { type: "extendSelectionDown" }
  | { type: "extendSelectionUp" }
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
  | { type: "deleteSelectedNodes" }
  | { type: "deleteSelectedNodesAndInsert"; char: string }
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

    case "extendSelectionDown":
    case "extendSelectionUp": {
      const { model, activeNodeId, cursorPos, selAnchorNodeId, selAnchorOffset } =
        state;
      if (!activeNodeId) return state;
      const order = getFlatOrder(model);
      const idx = order.indexOf(activeNodeId);
      const nextIdx =
        action.type === "extendSelectionDown" ? idx + 1 : idx - 1;
      if (nextIdx < 0 || nextIdx >= order.length) return state;

      // Anchor the selection at the current caret on the first extension;
      // keep the existing anchor while the selection is already spanning.
      const anchorNodeId = selAnchorNodeId ?? activeNodeId;
      const anchorOffset = selAnchorNodeId === null ? cursorPos : selAnchorOffset;
      const anchorIdx = order.indexOf(anchorNodeId);

      const newActiveId = order[nextIdx];
      const newNode = findNode(model, newActiveId);
      if (!newNode) return state;

      // Focus offset selects whole nodes as the focus passes them, and
      // collapses back to the caret when it returns to the anchor node.
      let focusOffset: number;
      if (newActiveId === anchorNodeId) focusOffset = anchorOffset;
      else if (nextIdx > anchorIdx) focusOffset = newNode.text.length;
      else focusOffset = 0;

      return {
        ...state,
        activeNodeId: newActiveId,
        editingText: newNode.text,
        cursorPos: focusOffset,
        selectionEnd: focusOffset,
        selAnchorNodeId: anchorNodeId,
        selAnchorOffset: anchorOffset,
      };
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

    case "deleteSelectedNodes": {
      // Node selection deletes WHOLE nodes (not a partial text range). Each
      // selected node is removed; any non-selected children are promoted by
      // removeNode. The caret lands at the end of the node before the range.
      const { model, activeNodeId, selAnchorNodeId } = state;
      if (!activeNodeId || !selAnchorNodeId) return state;
      const order = getFlatOrder(model);
      const anchorIdx = order.indexOf(selAnchorNodeId);
      const focusIdx = order.indexOf(activeNodeId);
      if (anchorIdx < 0 || focusIdx < 0) return state;

      const startIdx = Math.min(anchorIdx, focusIdx);
      const endIdx = Math.max(anchorIdx, focusIdx);
      const ids = order
        .slice(startIdx, endIdx + 1)
        .filter((id) => id !== model.id); // never delete the root
      if (ids.length === 0) return state;

      let newModel = model;
      for (let i = ids.length - 1; i >= 0; i--) {
        newModel = removeNode(newModel, ids[i]);
      }
      const prevId = startIdx > 0 ? order[startIdx - 1] : null;
      const landId =
        prevId && findNode(newModel, prevId) ? prevId : newModel.id;
      return focusNodeState(state, newModel, landId);
    }

    case "deleteSelectedNodesAndInsert": {
      // Replace a node selection: delete the nodes, then type the char at the
      // caret of the landing node.
      const deleted = editorReducer(state, { type: "deleteSelectedNodes" });
      if (deleted === state || !deleted.activeNodeId) return deleted;
      const node = findNode(deleted.model, deleted.activeNodeId);
      if (!node) return deleted;
      const cPos = deleted.cursorPos;
      const newText =
        node.text.substring(0, cPos) + action.char + node.text.substring(cPos);
      return {
        ...deleted,
        model: updateNodeText(deleted.model, deleted.activeNodeId, newText),
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
