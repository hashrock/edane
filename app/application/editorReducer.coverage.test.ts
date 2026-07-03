/**
 * Edge-case tests that target uncovered branches in editorReducer.ts:
 *  - Defensive "orphaned activeNodeId" guards (!currentNode / !node)
 *  - Collapsed-subtree paths where getFlatOrder skips the active node (idx = -1)
 */

import { describe, it, expect } from "vitest";
import type { MindMapModel } from "../domain/model";
import { findNode } from "../domain/model";
import { editorReducer, type EditorState } from "./editorReducer";

function sampleModel(): MindMapModel {
  return {
    id: "root",
    text: "Root",
    children: [
      { id: "a", text: "A", children: [{ id: "a1", text: "A1", children: [] }] },
      { id: "b", text: "B", children: [] },
    ],
  };
}

/** State where activeNodeId points to a node that does NOT exist in the model. */
function orphanState(model: MindMapModel): EditorState {
  return {
    document: { model, clipboard: null },
    view: {
      activeNodeId: "ghost",
      editing: true,
      editingText: "ghost",
      cursorPos: 5,
      selectionEnd: 5,
    },
  };
}

describe("orphaned activeNodeId — defensive !currentNode/!node guards", () => {
  it("enter returns same state when activeNodeId does not exist in model", () => {
    const s = orphanState(sampleModel());
    expect(editorReducer(s, { type: "enter", pos: 0 })).toBe(s);
  });

  it("backspaceAtStart returns same state when activeNodeId does not exist", () => {
    const s = orphanState(sampleModel());
    expect(editorReducer(s, { type: "backspaceAtStart" })).toBe(s);
  });

  it("deleteAtEnd returns same state when activeNodeId does not exist", () => {
    const s = orphanState(sampleModel());
    expect(editorReducer(s, { type: "deleteAtEnd", pos: 0 })).toBe(s);
  });

  it("cmdRight returns same state when activeNodeId does not exist", () => {
    const s = orphanState(sampleModel());
    expect(editorReducer(s, { type: "cmdRight", pos: 0 })).toBe(s);
  });

  it("cmdShiftRight returns same state when activeNodeId is null", () => {
    const base = orphanState(sampleModel());
    const s: EditorState = {
      ...base,
      view: { ...base.view, activeNodeId: null },
    };
    expect(editorReducer(s, { type: "cmdShiftRight", pos: 0, selEnd: 0 })).toBe(s);
  });

  it("cmdShiftRight returns same state when activeNodeId does not exist in model", () => {
    const s = orphanState(sampleModel());
    expect(editorReducer(s, { type: "cmdShiftRight", pos: 0, selEnd: 5 })).toBe(s);
  });

  it("copyBranch returns same state when activeNodeId does not exist", () => {
    const s = orphanState(sampleModel());
    expect(editorReducer(s, { type: "copyBranch" })).toBe(s);
  });

  it("pasteBranch returns same state when target node does not exist (with clipboard set)", () => {
    const clipboard: MindMapModel = { id: "cb", text: "Clip", children: [] };
    const base = orphanState(sampleModel());
    const s: EditorState = {
      ...base,
      document: { ...base.document, clipboard },
    };
    expect(editorReducer(s, { type: "pasteBranch" })).toBe(s);
  });

  it("startEditing returns same state when activeNodeId does not exist", () => {
    const s = orphanState(sampleModel());
    expect(editorReducer(s, { type: "startEditing" })).toBe(s);
  });

  it("exitEditing with stale activeNodeId exits edit mode with selectionEnd 0", () => {
    const s = orphanState(sampleModel());
    const next = editorReducer(s, { type: "exitEditing" });
    expect(next.view.editing).toBe(false);
    // node not found → text length defaults to 0 → selectionEnd = 0
    expect(next.view.cursorPos).toBe(0);
    expect(next.view.selectionEnd).toBe(0);
  });
});

describe("collapsed-subtree edge cases (idx = -1 in getFlatOrder)", () => {
  /** Model where 'a' is collapsed, hiding 'a1' from the flat navigation order. */
  function collapsedModel(): MindMapModel {
    return {
      id: "root",
      text: "Root",
      children: [
        {
          id: "a",
          text: "A",
          collapsed: true,
          children: [{ id: "a1", text: "", children: [] }],
        },
        { id: "b", text: "B", children: [] },
      ],
    };
  }

  it("backspaceAtStart on an empty collapsed node merges it into its parent", () => {
    const model = collapsedModel();
    // a1 is the (hidden) first child of collapsed "a"; its structural
    // predecessor is the parent "a", so the merge lands there — independent of
    // the flat navigation order / collapse state.
    const s: EditorState = {
      document: { model, clipboard: null },
      view: {
        activeNodeId: "a1",
        editing: true,
        editingText: "",
        cursorPos: 0,
        selectionEnd: 0,
      },
    };
    const next = editorReducer(s, { type: "backspaceAtStart" });
    expect(findNode(next.document.model, "a1")).toBeNull();
    expect(next.view.activeNodeId).toBe("a");
    expect(findNode(next.document.model, "a")!.text).toBe("A");
  });

  it("cutBranch on a node hidden inside a collapsed parent lands at root", () => {
    const model: MindMapModel = {
      id: "root",
      text: "Root",
      children: [
        {
          id: "a",
          text: "A",
          collapsed: true,
          children: [{ id: "a1", text: "A1", children: [] }],
        },
        { id: "b", text: "B", children: [] },
      ],
    };
    // a1 is hidden, so idx = -1 → prevId = null → landId = newModel.id = "root"
    const s: EditorState = {
      document: { model, clipboard: null },
      view: {
        activeNodeId: "a1",
        editing: true,
        editingText: "A1",
        cursorPos: 2,
        selectionEnd: 2,
      },
    };
    const next = editorReducer(s, { type: "cutBranch" });
    expect(findNode(next.document.model, "a1")).toBeNull();
    expect(next.view.activeNodeId).toBe("root");
    expect(next.document.clipboard?.text).toBe("A1");
  });

  it("deleteNode of the active node hidden inside collapsed parent refocuses to root", () => {
    const model: MindMapModel = {
      id: "root",
      text: "Root",
      children: [
        {
          id: "a",
          text: "A",
          collapsed: true,
          children: [{ id: "a1", text: "A1", children: [] }],
        },
        { id: "b", text: "B", children: [] },
      ],
    };
    // Deleting a1 while it is active; a1 is hidden → idx = -1 → landId = newModel.id
    const s: EditorState = {
      document: { model, clipboard: null },
      view: {
        activeNodeId: "a1",
        editing: true,
        editingText: "A1",
        cursorPos: 2,
        selectionEnd: 2,
      },
    };
    const next = editorReducer(s, { type: "deleteNode", nodeId: "a1" });
    expect(findNode(next.document.model, "a1")).toBeNull();
    expect(next.view.activeNodeId).toBe("root");
  });
});
