import { describe, it, expect } from "vitest";
import type { MindMapModel } from "../domain/model";
import { findNode } from "../domain/model";
import type { EditorState } from "./editorReducer";
import { selectionNodesToText } from "./clipboard";

// Root
//   A
//     A1
//   B
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

function selection(
  model: MindMapModel,
  anchorId: string,
  focusId: string
): EditorState {
  return {
    model,
    activeNodeId: focusId,
    editingText: findNode(model, focusId)?.text ?? "",
    cursorPos: 0,
    selectionEnd: 0,
    selAnchorNodeId: anchorId,
    selAnchorOffset: 0,
  };
}

describe("selectionNodesToText", () => {
  it("returns indented text for the DFS range (anchor → focus)", () => {
    const model = sampleModel();
    // DFS order: root, a, a1, b. Select a → b.
    const text = selectionNodesToText(selection(model, "a", "b"));
    expect(text).toBe("A\n  A1\nB");
  });

  it("normalises indentation to the shallowest selected node", () => {
    const model = sampleModel();
    // Select a1 → b: a1 is depth 2, b is depth 1 → base depth 1.
    const text = selectionNodesToText(selection(model, "a1", "b"));
    expect(text).toBe("  A1\nB");
  });

  it("works regardless of selection direction", () => {
    const model = sampleModel();
    expect(selectionNodesToText(selection(model, "b", "a"))).toBe(
      selectionNodesToText(selection(model, "a", "b"))
    );
  });

  it("returns empty string without a multi-node anchor", () => {
    const model = sampleModel();
    const s: EditorState = {
      ...selection(model, "a", "a"),
      selAnchorNodeId: null,
    };
    expect(selectionNodesToText(s)).toBe("");
  });
});
