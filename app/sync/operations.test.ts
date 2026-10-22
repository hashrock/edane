import { describe, expect, it } from "vitest";
import { applyPatch, diffDocument, parseCommit } from "../application/syncOperations";
import type { MindMapDocument } from "../domain/model";
import { editorReducer, type EditorState } from "../application/editorReducer";
import { UndoManager } from "../application/undoManager";
import { prepareActions } from "../components/webmcp";
const base = (): MindMapDocument => ({ title: "Note", roots: [{ id: "r", text: "Root", children: [{ id: "a", text: "A", children: [] }, { id: "b", text: "B", children: [] }] }] });
const edit = (fn: (d: MindMapDocument) => void) => { const d = base(); fn(d); return diffDocument(base(), d); };
const state = (model = base()): EditorState => ({ document: { model, clipboard: null }, view: { activeNodeId: "r", editing: false, editingText: "Root", cursorPos: 0, selectionEnd: 0, lastChildByParent: {} } });
describe("shared note operation semantics", () => {
  it("preserves edits to different nodes and different fields of the same node", () => {
    const a = edit(d => { d.roots[0].children[0].text = "Alice"; });
    const b = edit(d => { d.roots[0].children[1].text = "Bob"; d.roots[0].children[0].bold = true; });
    const result = applyPatch(applyPatch(base(), a), b);
    expect(result.roots[0].children.map(n => n.text)).toEqual(["Alice", "Bob"]);
    expect(result.roots[0].children[0].bold).toBe(true);
  });
  it("rejects same-field conflicts atomically", () => {
    const a = edit(d => { d.roots[0].text = "Alice"; });
    const b = edit(d => { d.title = "Bad partial update"; d.roots[0].text = "Bob"; });
    const current = applyPatch(base(), a);
    expect(() => applyPatch(current, b)).toThrow("r.text");
    expect(current.title).toBe("Note");
  });
  it("merges simultaneous children under the same parent", () => {
    const a = edit(d => { d.roots[0].children.splice(1, 0, { id: "x", text: "X", children: [] }); });
    const b = edit(d => { d.roots[0].children.splice(1, 0, { id: "y", text: "Y", children: [] }); });
    expect(applyPatch(applyPatch(base(), a), b).roots[0].children.map(n => n.id)).toEqual(["a", "x", "y", "b"]);
  });
  it("rejects deletion over a concurrent edit or child addition", () => {
    const removal = edit(d => { d.roots[0].children.shift(); });
    for (const change of [edit(d => { d.roots[0].children[0].text = "New"; }), edit(d => { d.roots[0].children[0].children.push({ id: "c", text: "C", children: [] }); })]) {
      expect(() => applyPatch(applyPatch(base(), change), removal)).toThrow();
      expect(() => applyPatch(applyPatch(base(), removal), change)).toThrow();
    }
  });
  it("round trips arbitrary reducer edits, including generated IDs", () => {
    let previous = state();
    for (const action of [{ type: "addChild", nodeId: "r" }, { type: "setNodeContent", nodeId: "a", text: "updated" }, { type: "moveBranch", nodeId: "a", newParentId: "b" }, { type: "deleteNode", nodeId: "b" }] as const) {
      const next = editorReducer(previous, action);
      const patch = diffDocument(previous.document.model, next.document.model);
      parseCommit({ id: "test", patch });
      expect(applyPatch(previous.document.model, patch)).toEqual(next.document.model);
      previous = next;
    }
  });
  it("undo/redo preserves remote edits and rejects conflicting inverses", () => {
    const manager = new UndoManager();
    const before = state().document;
    let current = { ...before, model: applyPatch(before.model, edit(d => { d.roots[0].children[0].text = "local"; })) };
    manager.setCommitCallback(() => current);
    manager.push("paste", before, current);
    current = { ...current, model: applyPatch(current.model, edit(d => { d.roots[0].children[1].text = "remote"; })) };
    current = manager.collaborativeStep("undo")!;
    expect(current.model.roots[0].children.map(n => n.text)).toEqual(["A", "remote"]);
    current = manager.collaborativeStep("redo")!;
    expect(current.model.roots[0].children.map(n => n.text)).toEqual(["local", "remote"]);
    current = structuredClone(current); current.model.roots[0].children[0].text = "other";
    expect(() => manager.collaborativeStep("undo")).toThrow();
    expect(manager.canUndo()).toBe(true);
  });
  it("validates WebMCP batches before any edit and preserves selection", () => {
    const initial = state();
    expect(() => prepareActions(initial, { actions: [{ type: "setTitle", text: "new" }, { type: "deleteNode", nodeId: "missing" }] })).toThrow();
    expect(initial.document.model.title).toBe("Note");
    const next = prepareActions(initial, { actions: [{ type: "setTitle", text: "new" }, { type: "addChild", nodeId: "r" }] });
    expect(next.document.model.title).toBe("new");
    expect(next.view.activeNodeId).toBe("r");
  });
  it("rejects malformed/unrecognized field values and graph cycles", () => {
    expect(() => parseCommit({ id: "ok", patch: { nodes: { x: { before: null, after: { fields: { text: "x", unknown: true }, children: [] } } } } })).toThrow();
    const cycle = edit(d => { d.roots[0].children[0].text = "x"; });
    cycle.nodes.a.after!.children = ["r"];
    expect(() => applyPatch(base(), cycle)).toThrow();
  });
});
