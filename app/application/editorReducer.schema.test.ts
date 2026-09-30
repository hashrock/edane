import { describe, it, expect } from "vitest";
import type { MindMapDocument, MindMapModel } from "../domain/model";
import { sequentialIds } from "../domain/model.arb";
import { editorReducer } from "./editorReducer";
import { editorStateAt } from "./editorState.arb";

const n = (id: string, text: string, children: MindMapModel[] = [], extra: Partial<MindMapModel> = {}): MindMapModel => ({
  id,
  text,
  children,
  ...extra,
});
const schema = "author, cover:image, done:check, tags[]";
const base: MindMapDocument = {
  title: "",
  roots: [n("c", "Books", [n("r1", "A", [n("a1", "Alice")])], { schema })],
};

describe("editorReducer × branch schema", () => {
  it("runs on Enter: a new record comes with its fields, focus stays on it", () => {
    const state = editorStateAt(base, "r1", { editing: true, pos: 1 });
    const next = editorReducer(state, { type: "enter", pos: 1 }, sequentialIds("k"));
    const records = next.document.model.roots[0].children;
    expect(records).toHaveLength(2);
    expect(next.view.activeNodeId).toBe(records[1].id);
    expect(records[1].children.map((c) => c.type ?? c.checked ?? "text")).toEqual(["text", "image", false, "text"]);
  });

  it("does not pad records a merge promoted into place", () => {
    // Backspace at the start of the first record joins it into the collection;
    // its field takes its slot as a record, and stays as it was.
    const state = editorStateAt(base, "r1", { editing: true, pos: 0 });
    const next = editorReducer(state, { type: "backspaceAtStart" }, sequentialIds("k"));
    expect(next.document.model.roots[0].children).toEqual([n("a1", "Alice")]);
  });

  it("setSchema stores trimmed text and removes it when blank, without touching records", () => {
    const state = editorStateAt(base, "c");
    const set = editorReducer(state, { type: "setSchema", nodeId: "c", schema: "  x:image  " });
    expect(set.document.model.roots[0].schema).toBe("x:image");
    expect(set.document.model.roots[0].children).toEqual(base.roots[0].children);
    const cleared = editorReducer(set, { type: "setSchema", nodeId: "c", schema: "" });
    expect("schema" in cleared.document.model.roots[0]).toBe(false);
  });
});
