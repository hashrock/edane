import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_THEME } from "../domain/pageTheme";
import { applyPatch, diffDocument, parseCommit } from "../application/syncOperations";
import type { MindMapDocument } from "../domain/model";
import { editorReducer, type EditorState } from "../application/editorReducer";
import { UndoManager } from "../application/undoManager";
import { prepareActions } from "../application/agentActions";
import { parseContent, serializeDocument } from "../application/persistence";
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
  it("patches are plain data that survive structured clone, even for a __proto__ id", () => {
    const patch = edit(d => { d.roots[0].children.push({ id: "__proto__", text: "P", children: [] }); });
    const cloned = structuredClone(patch);
    expect(Object.keys(cloned.nodes)).toContain("__proto__");
    expect(applyPatch(base(), parseCommit({ id: "c1", patch: cloned }).patch).roots[0].children.map(n => n.id)).toEqual(["a", "b", "__proto__"]);
  });
  it("a quick toggle sequence applies against the stored base, which drops collapsed: false and bold: false", () => {
    // NoteRoom reloads every commit's base from storage (serialize → parse).
    const reload = (d: MindMapDocument) => parseContent(serializeDocument(d), d.title);
    const withChild = (): MindMapDocument => { const d = base(); d.roots[0].children[0].children.push({ id: "c", text: "C", children: [] }); return d; };
    let local = state(withChild());
    let server = reload(withChild());
    for (const action of [
      { type: "toggleCollapse", nodeId: "a" }, { type: "toggleCollapse", nodeId: "a" }, { type: "toggleCollapse", nodeId: "a" },
      { type: "setNodeStyle", nodeId: "a", bold: true }, { type: "setNodeStyle", nodeId: "a", bold: false }, { type: "setNodeStyle", nodeId: "a", bold: true },
    ] as const) {
      const next = editorReducer(local, action);
      server = reload(applyPatch(server, diffDocument(local.document.model, next.document.model)));
      local = next;
    }
    expect(server.roots[0].children[0]).toMatchObject({ collapsed: true, bold: true });
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
  it("carries the page theme, and two sessions editing it at once conflict", () => {
    const before = base();
    const mine = { ...before, theme: { ...DEFAULT_PAGE_THEME, accentColor: "#ff0000" } };
    const theirs = { ...before, theme: { ...DEFAULT_PAGE_THEME, accentColor: "#0000ff" } };
    const patch = parseCommit({ id: "t", patch: diffDocument(before, mine) }).patch;
    expect(applyPatch(before, patch)).toEqual(mine);
    expect(() => applyPatch(applyPatch(before, diffDocument(before, theirs)), patch)).toThrow(/theme/);
    // Back to no theme at all.
    expect(applyPatch(mine, diffDocument(mine, before))).toEqual(before);
  });
  it("rejects a theme that isn't well-formed", () => {
    const bad = (theme: unknown) => () => parseCommit({ id: "t", patch: { nodes: {}, theme: { before: null, after: theme } } });
    expect(bad({ ...DEFAULT_PAGE_THEME, textColor: "red" })).toThrow(/theme/);
    expect(bad({ ...DEFAULT_PAGE_THEME, extra: 1 })).toThrow(/theme/);
    expect(bad("x")).toThrow(/theme/);
    expect(bad(DEFAULT_PAGE_THEME)).not.toThrow();
  });
  it("rejects malformed/unrecognized field values and graph cycles", () => {
    expect(() => parseCommit({ id: "ok", patch: { nodes: { x: { before: null, after: { fields: { text: "x", unknown: true }, children: [] } } } } })).toThrow();
    const cycle = edit(d => { d.roots[0].children[0].text = "x"; });
    cycle.nodes.a.after!.children = ["r"];
    expect(() => applyPatch(base(), cycle)).toThrow();
  });
});
