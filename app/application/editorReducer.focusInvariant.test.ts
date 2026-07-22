/**
 * Invariant test: "exactly ONE node is always active" (see the module doc
 * comment at the top of editorReducer.ts) means `view.activeNodeId`, whenever
 * non-null, must resolve to a node that actually exists in the resulting
 * `document.model`. Today this is only enforced ad hoc, one branch at a time
 * (the `!currentNode`/`!node` guards covered by editorReducer.coverage.test.ts)
 * plus, for undo/redo specifically, by reconcileView — nothing checks it holds
 * for every EditorAction variant dispatched through the normal path.
 *
 * The `satisfies Record<EditorAction["type"], EditorAction>` table below turns
 * that gap into a compile error: adding a new EditorAction variant without
 * adding a sample here fails typecheck, so the invariant can't silently stop
 * being exercised for a future action.
 */

import { describe, it, expect } from "vitest";
import type { MindMapModel } from "../domain/model";
import { findNode } from "../domain/model";
import {
  editorReducer,
  type EditorAction,
  type EditorState,
} from "./editorReducer";

function sampleModel(): MindMapModel {
  return {
    id: "root",
    text: "Root",
    children: [
      {
        id: "a",
        text: "A",
        children: [{ id: "a1", text: "A1", children: [] }],
      },
      { id: "b", text: "B", children: [] },
    ],
  };
}

/** Editing state focused on "a1" (a leaf with a parent and a sibling subtree). */
function baseState(clipboard: MindMapModel | null = null): EditorState {
  return {
    document: { model: sampleModel(), clipboard },
    view: {
      activeNodeId: "a1",
      editing: true,
      editingText: "A1",
      cursorPos: 2,
      selectionEnd: 2,
    },
  };
}

// One representative action per EditorAction variant, all referencing ids
// that exist in sampleModel(). `satisfies` forces this table to stay in sync
// with EditorAction — see the module doc comment above.
const ACTIONS = {
  enter: { type: "enter", pos: 2 },
  tab: { type: "tab", shift: false },
  backspaceAtStart: { type: "backspaceAtStart" },
  deleteAtEnd: { type: "deleteAtEnd", pos: 2 },
  moveNodeUp: { type: "moveNodeUp" },
  moveNodeDown: { type: "moveNodeDown" },
  moveBranch: { type: "moveBranch", nodeId: "a1", newParentId: "b" },
  moveUp: { type: "moveUp" },
  moveDown: { type: "moveDown" },
  moveToParent: { type: "moveToParent" },
  cmdLeft: { type: "cmdLeft", pos: 2 },
  cmdRight: { type: "cmdRight", pos: 2 },
  cmdShiftLeft: { type: "cmdShiftLeft", pos: 2, selEnd: 0 },
  cmdShiftRight: { type: "cmdShiftRight", pos: 0, selEnd: 2 },
  arrowLeftEdge: { type: "arrowLeftEdge" },
  arrowRightEdge: { type: "arrowRightEdge" },
  typeText: {
    type: "typeText",
    text: "X",
    cursorPos: 1,
    selectionEnd: 1,
    commitModel: true,
  },
  setSelection: { type: "setSelection", cursorPos: 0, selectionEnd: 2 },
  copyBranch: { type: "copyBranch" },
  cutBranch: { type: "cutBranch" },
  pasteBranch: { type: "pasteBranch" },
  activateNode: {
    type: "activateNode",
    nodeId: "b",
    cursorPos: 0,
    selectionEnd: 0,
    editing: false,
  },
  selectAllInNode: { type: "selectAllInNode", nodeId: "a1" },
  startEditing: { type: "startEditing" },
  exitEditing: { type: "exitEditing" },
  dragSelect: {
    type: "dragSelect",
    nodeId: "a1",
    anchorOffset: 0,
    focusOffset: 2,
  },
  insertSiblingAfter: { type: "insertSiblingAfter" },
  toggleCollapse: { type: "toggleCollapse", nodeId: "a" },
  addChild: { type: "addChild", nodeId: "a1" },
  deleteNode: { type: "deleteNode", nodeId: "a1" },
  setNodeType: { type: "setNodeType", nodeId: "a1", nodeType: "text" },
  setNodeContent: { type: "setNodeContent", nodeId: "a1", text: "x" },
  setNodeStyle: { type: "setNodeStyle", nodeId: "a1", bold: true },
  setLinkMeta: { type: "setLinkMeta", nodeId: "a1", linkTitle: "t" },
  setNumFormat: { type: "setNumFormat", nodeId: "a1", numFormat: "comma" },
  insertNodes: {
    type: "insertNodes",
    targetId: "a1",
    nodes: [{ id: "new1", text: "N", children: [] }],
  },
  setTitle: { type: "setTitle", text: "New Title" },
  replace: { type: "replace", state: baseState() },
} satisfies Record<EditorAction["type"], EditorAction>;

describe("invariant: view.activeNodeId always resolves in the resulting document", () => {
  for (const [name, action] of Object.entries(ACTIONS)) {
    it(`${name} leaves activeNodeId resolvable (or null)`, () => {
      const clipboard: MindMapModel | null =
        action.type === "pasteBranch"
          ? { id: "clip", text: "Clip", children: [] }
          : null;
      const state = baseState(clipboard);
      const next = editorReducer(state, action as EditorAction);

      if (next.view.activeNodeId !== null) {
        expect(findNode(next.document.model, next.view.activeNodeId)).not.toBeNull();
      }
    });
  }
});
