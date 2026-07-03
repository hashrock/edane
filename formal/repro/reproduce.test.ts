/**
 * Executable reproductions of the model-checker counterexamples, run against
 * the REAL edane domain/application code (no re-implementation). Each test
 * pins the surprising behavior a formal model predicted, so the findings stay
 * reproducible and reviewable.
 *
 * Run:  npx vitest run --config formal/repro/vitest.config.ts
 */
import { describe, it, expect } from "vitest";
import type { MindMapModel } from "../../app/domain/model";
import { getFlatOrder, removeNode, findNode } from "../../app/domain/model";
import {
  editorReducer,
  reconcileView,
  type EditorState,
} from "../../app/application/editorReducer";

const mk = (id: string, text: string, children: MindMapModel[] = []): MindMapModel => ({
  id,
  text,
  children,
});
const state = (model: MindMapModel, activeNodeId: string): EditorState => ({
  document: { model, clipboard: null },
  view: { activeNodeId, editing: true, editingText: "", cursorPos: 0, selectionEnd: 0 },
});
const ids = (m: MindMapModel): string[] => [m.id, ...m.children.flatMap(ids)];

describe("FINDING 1 (Z3 flat_order_merge): backspace merges across subtrees", () => {
  it("splices B's text into A1 (a different subtree) and orphans B's children", () => {
    // Root -> A -> A1 ;  Root -> B -> {B1, B2}
    const model = mk("root", "Root", [
      mk("A", "A", [mk("A1", "A1")]),
      mk("B", "B", [mk("B1", "B1"), mk("B2", "B2")]),
    ]);
    // getFlatOrder is DFS pre-order: the node visually "above" B is A1, not A.
    expect(getFlatOrder(model)).toEqual(["root", "A", "A1", "B", "B1", "B2"]);

    const next = editorReducer(state(model, "B"), { type: "backspaceAtStart" });

    // B's text landed on A1 (two levels deep in a sibling branch).
    expect(findNode(next.document.model, "A1")!.text).toBe("A1B");
    // B is gone; its children were promoted to the ROOT level, not kept with
    // the text they belonged to.
    expect(findNode(next.document.model, "B")).toBeNull();
    expect(next.document.model.children.map((c) => c.id)).toEqual(["A", "B1", "B2"]);
    // The caret follows the text into the foreign subtree.
    expect(next.view.editingText).toBe("A1B");
  });
});

describe("FINDING 2 (Alloy DuplicateIdHazard): unique-id is assumed, not enforced", () => {
  it("removeNode deletes only the FIRST node with a duplicated id", () => {
    // parseContent() accepts this shape (id:string, text:string, children:[]).
    const model = mk("root", "Root", [mk("dup", "First"), mk("dup", "Second")]);
    const after = removeNode(model, "dup");
    // Intent: "delete the node with id 'dup'". Reality: one 'dup' survives.
    expect(after.children.map((c) => c.text)).toEqual(["Second"]);
    expect(findNode(after, "dup")!.text).toBe("Second");
  });
});

describe("FINDING 3 (TLA+/Z3 undo_redo): dangling selection until reconcile", () => {
  it("an active id can reference a node absent from the document", () => {
    // Simulate undo restoring a document that lacks the still-active node.
    const restoredDoc = { model: mk("root", "Root", []), clipboard: null };
    const danglingView = {
      activeNodeId: "ghost", // created by an edit the undo rolled back
      editing: false,
      editingText: "",
      cursorPos: 0,
      selectionEnd: 0,
    };
    // Before reconcileView(), the active node does not exist -> every keyboard
    // action would no-op (documentReducer guards on findNode === null).
    expect(findNode(restoredDoc.model, danglingView.activeNodeId)).toBeNull();
    // reconcileView() is the *separate* repair the caller must remember to run.
    const fixed = reconcileView(danglingView, restoredDoc);
    expect(fixed.activeNodeId).toBe("root");
  });
});

describe("FINDING 4 (execution probe): node identity is not stable on split", () => {
  it("Enter at the start of a node empties it and moves text+children to a NEW id", () => {
    const model = mk("root", "Root", [mk("P", "Parent", [mk("C", "Child")])]);
    const before = ids(model);
    const next = editorReducer(state(model, "P"), { type: "enter", pos: 0 });

    const p = findNode(next.document.model, "P")!;
    expect(p.text).toBe(""); // the node the user was on is now blank...
    expect(p.children).toHaveLength(0); // ...and lost its subtree

    // A brand-new node id now holds the original text and the child.
    const newIds = ids(next.document.model).filter((id) => !before.includes(id));
    expect(newIds).toHaveLength(1);
    const moved = findNode(next.document.model, newIds[0])!;
    expect(moved.text).toBe("Parent");
    expect(moved.children.map((c) => c.id)).toEqual(["C"]);
  });
});
