/**
 * Application layer: editor state reducer.
 *
 * Single source of truth (EditorState) reduced by EditorAction.
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

export interface EditorState {
  model: MindMapModel;
  activeNodeId: string | null;
  // When a node is active, distinguishes "editing" (caret + text input) from
  // "selected" (node highlighted, single click). Always false when no node is
  // active.
  editing: boolean;
  editingText: string;
  cursorPos: number;
  selectionEnd: number;
  // Internal branch clipboard: the subtree captured by copyBranch / cutBranch,
  // pasted as a child of the active node by pasteBranch. null = empty.
  clipboard: MindMapModel | null;
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

// --- Helpers ---

/**
 * Move focus to a node, resolving its text from the model. Defaults the
 * cursor to the end of the text. Preserves the current edit mode and clipboard.
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
    // Keep the current mode: structural edits stay in edit mode, while
    // selection-mode navigation (move up/down) stays in selection mode.
    editing: state.editing,
    editingText: text,
    cursorPos: pos,
    selectionEnd: sel,
    clipboard: state.clipboard,
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
        // Empty node: delete it, move to the previous node (root at worst).
        const newModel = removeNode(model, activeNodeId);
        const landId = idx > 0 ? order[idx - 1] : newModel.id;
        return focusNodeState(state, newModel, landId);
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
        // Typing always implies edit mode (covers typing on a selected node).
        editing: true,
        editingText: action.text,
        cursorPos: action.cursorPos,
        selectionEnd: action.selectionEnd,
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

    case "copyBranch": {
      const { activeNodeId } = state;
      if (!activeNodeId) return state;
      const node = findNode(state.model, activeNodeId);
      if (!node) return state;
      // Snapshot the subtree (own ids); pasteBranch re-ids on insert.
      return { ...state, clipboard: cloneModel(node) };
    }

    case "cutBranch": {
      const { model, activeNodeId } = state;
      if (!activeNodeId || activeNodeId === model.id) return state; // never cut root
      const order = getFlatOrder(model);
      const idx = order.indexOf(activeNodeId);
      const { model: newModel, removed } = detachBranch(model, activeNodeId);
      if (!removed) return state;
      const prevId = idx > 0 ? order[idx - 1] : null;
      const landId =
        prevId && findNode(newModel, prevId) ? prevId : newModel.id;
      return { ...focusNodeState(state, newModel, landId), clipboard: removed };
    }

    case "pasteBranch": {
      const { model, activeNodeId, clipboard } = state;
      if (!activeNodeId || !clipboard) return state;
      const target = findNode(model, activeNodeId);
      if (!target) return state;
      const fresh = cloneWithNewIds(clipboard);
      // Expand the target so the pasted child is visible, then append it.
      let newModel = toggleCollapse(model, activeNodeId, false);
      newModel = addChildToNode(newModel, activeNodeId, fresh);
      // Keep the clipboard so the branch can be pasted again.
      return { ...focusNodeState(state, newModel, fresh.id), clipboard };
    }

    case "activateNode": {
      const node = findNode(state.model, action.nodeId);
      if (!node) return state;
      return {
        ...state,
        activeNodeId: action.nodeId,
        editing: action.editing,
        editingText: node.text,
        cursorPos: action.cursorPos,
        selectionEnd: action.selectionEnd,
      };
    }

    case "startEditing": {
      if (!state.activeNodeId) return state;
      const node = findNode(state.model, state.activeNodeId);
      if (!node) return state;
      return {
        ...state,
        editing: true,
        editingText: node.text,
        cursorPos: action.cursorPos ?? 0,
        selectionEnd: action.selectionEnd ?? node.text.length,
      };
    }

    case "exitEditing": {
      if (!state.activeNodeId || !state.editing) return state;
      const node = findNode(state.model, state.activeNodeId);
      const len = node?.text.length ?? 0;
      return {
        ...state,
        editing: false,
        // Back to selection mode: select the whole text so a follow-up keypress
        // replaces it, matching the just-selected-node behaviour.
        cursorPos: 0,
        selectionEnd: len,
      };
    }

    case "selectAllInNode": {
      const node = findNode(state.model, action.nodeId);
      if (!node) return state;
      return {
        ...state,
        activeNodeId: action.nodeId,
        editing: true,
        editingText: node.text,
        cursorPos: 0,
        selectionEnd: node.text.length,
      };
    }

    case "dragSelect": {
      const focusNode = findNode(state.model, action.focusNodeId);
      if (!focusNode) return state;
      if (action.focusNodeId === action.anchorNodeId) {
        // Same node: dragging selects a text range, which is an editing gesture.
        const start = Math.min(action.anchorOffset, action.focusOffset);
        const end = Math.max(action.anchorOffset, action.focusOffset);
        return {
          ...state,
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
        ...state,
        activeNodeId: action.focusNodeId,
        editing: false,
        editingText: focusNode.text,
        cursorPos: action.focusOffset,
        selectionEnd: action.focusOffset,
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
      };
    }

    case "toggleCollapse": {
      const node = findNode(state.model, action.nodeId);
      if (!node || node.children.length === 0) return state;
      const newModel = toggleCollapse(state.model, action.nodeId);
      // If the focused node just got hidden, move focus to the toggled node.
      if (
        state.activeNodeId &&
        !getFlatOrder(newModel).includes(state.activeNodeId)
      ) {
        return focusNodeState(state, newModel, action.nodeId);
      }
      return { ...state, model: newModel };
    }

    case "addChild": {
      const parent = findNode(state.model, action.nodeId);
      if (!parent) return state;
      const newId = generateId();
      const newNode: MindMapModel = { id: newId, text: "", children: [] };
      // Expand first so the new child is visible, then append it.
      let newModel = toggleCollapse(state.model, action.nodeId, false);
      newModel = addChildToNode(newModel, action.nodeId, newNode);
      return focusNodeState(state, newModel, newId);
    }

    case "deleteNode": {
      if (action.nodeId === state.model.id) return state; // never delete root
      const order = getFlatOrder(state.model);
      const idx = order.indexOf(action.nodeId);
      const newModel = removeNode(state.model, action.nodeId);
      // Only refocus if the currently active node disappeared.
      if (state.activeNodeId && !findNode(newModel, state.activeNodeId)) {
        const prevId = idx > 0 ? order[idx - 1] : null;
        const landId =
          prevId && findNode(newModel, prevId) ? prevId : newModel.id;
        return focusNodeState(state, newModel, landId);
      }
      return { ...state, model: newModel };
    }

    case "setNodeType": {
      const node = findNode(state.model, action.nodeId);
      if (!node) return state;
      const newModel = setNodeType(state.model, action.nodeId, action.nodeType);
      // Activate the node so its URL/label can be edited as text right away.
      return focusNodeState(state, newModel, action.nodeId);
    }

    case "setNodeContent": {
      const node = findNode(state.model, action.nodeId);
      if (!node) return state;
      let newModel = updateNodeText(state.model, action.nodeId, action.text);
      if (action.nodeType) {
        newModel = setNodeType(newModel, action.nodeId, action.nodeType);
      }
      if (state.activeNodeId === action.nodeId) {
        return {
          ...state,
          model: newModel,
          editingText: action.text,
          cursorPos: action.text.length,
          selectionEnd: action.text.length,
        };
      }
      return { ...state, model: newModel };
    }

    case "setNodeStyle": {
      const node = findNode(state.model, action.nodeId);
      if (!node) return state;
      const newModel = setNodeStyle(state.model, action.nodeId, {
        fontSize: action.fontSize,
        bold: action.bold,
      });
      return { ...state, model: newModel };
    }

    case "setLinkMeta": {
      const node = findNode(state.model, action.nodeId);
      if (!node) return state;
      const newModel = setLinkMeta(state.model, action.nodeId, {
        linkTitle: action.linkTitle,
        favicon: action.favicon,
      });
      return { ...state, model: newModel };
    }

    case "setTitle": {
      const nextModel = updateNodeText(state.model, state.model.id, action.text);
      if (state.activeNodeId === state.model.id) {
        const clamp = (pos: number) => Math.min(pos, action.text.length);
        return {
          ...state,
          model: nextModel,
          editingText: action.text,
          cursorPos: clamp(state.cursorPos),
          selectionEnd: clamp(state.selectionEnd),
        };
      }
      return {
        ...state,
        model: nextModel,
      };
    }

    case "replace": {
      return action.state;
    }
  }
}
