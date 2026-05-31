import { describe, it, expect } from "vitest";
import { editorReducer, type EditorState } from "./editorReducer";
import { findNode, type MindMapModel } from "../domain/model";

function makeModel(): MindMapModel {
  return {
    id: "root",
    text: "Root",
    children: [
      { id: "a", text: "Alpha", children: [] },
      { id: "b", text: "https://example.com", children: [], type: "link" },
    ],
  };
}

function makeState(
  model: MindMapModel,
  activeNodeId: string | null = null
): EditorState {
  return {
    model,
    activeNodeId,
    editing: activeNodeId !== null,
    editingText: activeNodeId ? findNode(model, activeNodeId)?.text ?? "" : "",
    cursorPos: 0,
    selectionEnd: 0,
    selAnchorNodeId: null,
    selAnchorOffset: 0,
  };
}

describe("editorReducer formatting actions", () => {
  it("setNodeStyle sets and clears font size", () => {
    const s0 = makeState(makeModel());
    const s1 = editorReducer(s0, { type: "setNodeStyle", nodeId: "a", fontSize: 24 });
    expect(findNode(s1.model, "a")?.fontSize).toBe(24);
    // null clears it back to the default (absent).
    const s2 = editorReducer(s1, { type: "setNodeStyle", nodeId: "a", fontSize: null });
    expect(findNode(s2.model, "a")?.fontSize).toBeUndefined();
  });

  it("setNodeStyle toggles bold", () => {
    const s0 = makeState(makeModel());
    const s1 = editorReducer(s0, { type: "setNodeStyle", nodeId: "a", bold: true });
    expect(findNode(s1.model, "a")?.bold).toBe(true);
    const s2 = editorReducer(s1, { type: "setNodeStyle", nodeId: "a", bold: false });
    expect(findNode(s2.model, "a")?.bold).toBeUndefined();
  });

  it("setLinkMeta stores title + favicon and clears on empty", () => {
    const s0 = makeState(makeModel());
    const s1 = editorReducer(s0, {
      type: "setLinkMeta",
      nodeId: "b",
      linkTitle: "Example Domain",
      favicon: "https://example.com/favicon.ico",
    });
    expect(findNode(s1.model, "b")?.linkTitle).toBe("Example Domain");
    expect(findNode(s1.model, "b")?.favicon).toBe("https://example.com/favicon.ico");
    const s2 = editorReducer(s1, {
      type: "setLinkMeta",
      nodeId: "b",
      linkTitle: "",
      favicon: null,
    });
    expect(findNode(s2.model, "b")?.linkTitle).toBeUndefined();
    expect(findNode(s2.model, "b")?.favicon).toBeUndefined();
  });

  it("setNodeContent sets text + type and syncs the editing buffer when active", () => {
    const s0 = makeState(makeModel(), "a");
    const s1 = editorReducer(s0, {
      type: "setNodeContent",
      nodeId: "a",
      text: "/api/images/x/raw",
      nodeType: "image",
    });
    const node = findNode(s1.model, "a");
    expect(node?.text).toBe("/api/images/x/raw");
    expect(node?.type).toBe("image");
    // Active node: editing buffer + caret follow the new text.
    expect(s1.editingText).toBe("/api/images/x/raw");
    expect(s1.cursorPos).toBe("/api/images/x/raw".length);
  });

  it("formatting an unknown node is a no-op (same reference)", () => {
    const s0 = makeState(makeModel());
    const s1 = editorReducer(s0, { type: "setNodeStyle", nodeId: "missing", bold: true });
    expect(s1).toBe(s0);
  });
});
