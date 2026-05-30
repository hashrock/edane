/**
 * Application layer: pure editor action functions.
 * Each action takes current state + input context, returns state updates.
 * No React or DOM dependencies — purely functional state transforms.
 */

import type { MindMapModel } from "../domain/model";
import {
  findNode,
  getFlatOrder,
  generateId,
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
  // Multi-node selection anchor (null = same as activeNodeId)
  selAnchorNodeId: string | null;
  selAnchorOffset: number;
}

/** Partial state update returned by actions. null = no action taken. */
export type StateUpdate = Partial<EditorState> | null;

// --- Helpers ---

export function isMultiNodeSelection(state: EditorState): boolean {
  return (
    state.selAnchorNodeId !== null &&
    state.selAnchorNodeId !== state.activeNodeId
  );
}

/** Collapse a multi-node selection by deleting the range */
export function collapseMultiNodeSelection(state: EditorState): StateUpdate {
  const { model, activeNodeId, selAnchorNodeId, selAnchorOffset, cursorPos } =
    state;
  if (!activeNodeId || !selAnchorNodeId || selAnchorNodeId === activeNodeId)
    return null;

  const { model: newModel, cursorNodeId, cursorOffset } = deleteNodeRange(
    model,
    selAnchorNodeId,
    selAnchorOffset,
    activeNodeId,
    cursorPos
  );
  const node = findNode(newModel, cursorNodeId);
  return {
    model: newModel,
    activeNodeId: cursorNodeId,
    editingText: node?.text || "",
    cursorPos: cursorOffset,
    selectionEnd: cursorOffset,
    selAnchorNodeId: null,
    selAnchorOffset: 0,
  };
}

/** Collapse single-node selection (just set cursor, no deletion) */
export function hasAnySelection(state: EditorState): boolean {
  return (
    isMultiNodeSelection(state) ||
    state.cursorPos !== state.selectionEnd
  );
}

// --- Actions ---

export function handleEnter(
  state: EditorState,
  inputPos: number
): StateUpdate {
  const { model, activeNodeId } = state;
  if (!activeNodeId) return null;
  const currentNode = findNode(model, activeNodeId);
  if (!currentNode) return null;

  if (inputPos >= currentNode.text.length) {
    // At end: add empty sibling
    const newId = generateId();
    const newNode: MindMapModel = { id: newId, text: "", children: [] };
    return {
      model: addSiblingAfter(model, activeNodeId, newNode),
      activeNodeId: newId,
      editingText: "",
      cursorPos: 0,
      selectionEnd: 0,
    };
  } else {
    // Mid-text: split node
    const textAfter = currentNode.text.substring(inputPos);
    const result = splitNode(model, activeNodeId, inputPos);
    return {
      model: result.model,
      activeNodeId: result.newNodeId,
      editingText: textAfter,
      cursorPos: 0,
      selectionEnd: 0,
    };
  }
}

export function handleTab(
  state: EditorState,
  shiftKey: boolean
): StateUpdate {
  const { model, activeNodeId } = state;
  if (!activeNodeId) return null;
  return {
    model: shiftKey
      ? dedentNode(model, activeNodeId)
      : indentNode(model, activeNodeId),
  };
}

export function handleBackspaceAtStart(
  state: EditorState
): StateUpdate {
  const { model, activeNodeId } = state;
  if (!activeNodeId) return null;

  const currentNode = findNode(model, activeNodeId);
  if (!currentNode) return null;

  const order = getFlatOrder(model);
  const idx = order.indexOf(activeNodeId);

  if (currentNode.text === "" && model.id !== activeNodeId) {
    // Empty node: delete it, move to previous
    const newModel = removeNode(model, activeNodeId);
    if (idx > 0) {
      const prevId = order[idx - 1];
      const prevNode = findNode(model, prevId);
      const prevText = prevNode?.text || "";
      return {
        model: newModel,
        activeNodeId: prevId,
        editingText: prevText,
        cursorPos: prevText.length,
        selectionEnd: prevText.length,
      };
    }
    return { model: newModel, activeNodeId: null };
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
        model: newModel,
        activeNodeId: prevId,
        editingText: mergedText,
        cursorPos: mergePos,
        selectionEnd: mergePos,
      };
    }
  }

  return null;
}

export function handleDeleteAtEnd(
  state: EditorState,
  inputPos: number
): StateUpdate {
  const { model, activeNodeId } = state;
  if (!activeNodeId) return null;

  const currentNode = findNode(model, activeNodeId);
  if (!currentNode) return null;

  const order = getFlatOrder(model);
  const idx = order.indexOf(activeNodeId);

  if (inputPos >= currentNode.text.length && idx < order.length - 1) {
    const nextId = order[idx + 1];
    const nextNode = findNode(model, nextId);
    if (nextNode) {
      const mergedText = currentNode.text + nextNode.text;
      let newModel = updateNodeText(model, activeNodeId, mergedText);
      newModel = removeNode(newModel, nextId);
      return {
        model: newModel,
        editingText: mergedText,
        cursorPos: inputPos,
        selectionEnd: inputPos,
      };
    }
  }

  return null;
}

export function handleArrowUp(state: EditorState): StateUpdate {
  const { model, activeNodeId } = state;
  if (!activeNodeId) return null;
  const order = getFlatOrder(model);
  const idx = order.indexOf(activeNodeId);
  if (idx > 0) {
    return { activeNodeId: order[idx - 1] };
  }
  return null;
}

export function handleArrowDown(state: EditorState): StateUpdate {
  const { model, activeNodeId } = state;
  if (!activeNodeId) return null;
  const order = getFlatOrder(model);
  const idx = order.indexOf(activeNodeId);
  if (idx < order.length - 1) {
    return { activeNodeId: order[idx + 1] };
  }
  return null;
}

export function handleCmdLeft(
  state: EditorState,
  inputPos: number
): StateUpdate {
  const { model, activeNodeId } = state;
  if (!activeNodeId) return null;
  const order = getFlatOrder(model);
  const idx = order.indexOf(activeNodeId);

  if (inputPos === 0 && idx > 0) {
    // Already at start → jump to end of previous node
    return { activeNodeId: order[idx - 1] };
  }
  // Jump to start of current node
  return { cursorPos: 0, selectionEnd: 0 };
}

export function handleCmdRight(
  state: EditorState,
  inputPos: number
): StateUpdate {
  const { model, activeNodeId } = state;
  if (!activeNodeId) return null;
  const currentNode = findNode(model, activeNodeId);
  if (!currentNode) return null;

  const order = getFlatOrder(model);
  const idx = order.indexOf(activeNodeId);

  if (inputPos >= currentNode.text.length && idx < order.length - 1) {
    // Already at end → jump to start of next node
    const nextId = order[idx + 1];
    return { activeNodeId: nextId, cursorPos: 0, selectionEnd: 0 };
  }
  // Jump to end of current node
  const endPos = currentNode.text.length;
  return { cursorPos: endPos, selectionEnd: endPos };
}

export function handleCmdShiftLeft(
  state: EditorState,
  inputPos: number,
  inputSelEnd: number
): StateUpdate {
  const { activeNodeId } = state;
  if (!activeNodeId) return null;
  // Extend selection to start of node, anchor stays
  const anchor = inputPos < inputSelEnd ? inputSelEnd : inputSelEnd;
  return { cursorPos: 0, selectionEnd: anchor };
}

export function handleCmdShiftRight(
  state: EditorState,
  inputPos: number,
  inputSelEnd: number
): StateUpdate {
  const { model, activeNodeId } = state;
  if (!activeNodeId) return null;
  const currentNode = findNode(model, activeNodeId);
  if (!currentNode) return null;
  // Extend selection to end of node, anchor stays
  const anchor = inputPos < inputSelEnd ? inputPos : inputPos;
  return { cursorPos: anchor, selectionEnd: currentNode.text.length };
}

export function handleArrowLeftEdge(state: EditorState): StateUpdate {
  const { model, activeNodeId } = state;
  if (!activeNodeId) return null;
  const order = getFlatOrder(model);
  const idx = order.indexOf(activeNodeId);
  if (idx > 0) {
    return { activeNodeId: order[idx - 1] };
  }
  return null;
}

export function handleArrowRightEdge(state: EditorState): StateUpdate {
  const { model, activeNodeId } = state;
  if (!activeNodeId) return null;
  const order = getFlatOrder(model);
  const idx = order.indexOf(activeNodeId);
  if (idx < order.length - 1) {
    const nextId = order[idx + 1];
    return { activeNodeId: nextId, cursorPos: 0, selectionEnd: 0 };
  }
  return null;
}
