/**
 * Regression tests for the model-checker findings, run against the REAL edane
 * domain/application code (no re-implementation). Each test originally pinned a
 * *surprising* behaviour a formal model predicted (see FINDINGS.md); now that
 * the findings are fixed, each test pins the CORRECTED behaviour so the fix
 * can't silently regress.
 *
 * Run:  npx vitest run --config formal/repro/vitest.config.ts
 */
import { describe, it, expect } from "vitest";
import type { MindMapModel } from "../../app/domain/model";
import { getFlatOrder, removeNode, findNode } from "../../app/domain/model";
import {
  editorReducer,
  type EditorState,
} from "../../app/application/editorReducer";
import { parseContent, serializeModel } from "../../app/application/persistence";

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

describe("FINDING 1 (Z3 flat_order_merge): backspace no longer merges across subtrees", () => {
  it("merges B into its previous sibling A and keeps B's children with the text", () => {
    // Root -> A -> A1 ;  Root -> B -> {B1, B2}
    const model = mk("root", "Root", [
      mk("A", "A", [mk("A1", "A1")]),
      mk("B", "B", [mk("B1", "B1"), mk("B2", "B2")]),
    ]);
    // getFlatOrder is DFS pre-order: the node visually "above" B is A1, not A.
    expect(getFlatOrder(model)).toEqual(["root", "A", "A1", "B", "B1", "B2"]);

    const next = editorReducer(state(model, "B"), { type: "backspaceAtStart" });

    // B's text merges into its structural predecessor A — NOT the DFS-previous
    // leaf A1, which stays untouched inside A's subtree.
    expect(findNode(next.document.model, "A")!.text).toBe("AB");
    expect(findNode(next.document.model, "A1")!.text).toBe("A1");
    // B is gone; its children travel with the text under A (not orphaned to root).
    expect(findNode(next.document.model, "B")).toBeNull();
    expect(findNode(next.document.model, "A")!.children.map((c) => c.id)).toEqual([
      "A1",
      "B1",
      "B2",
    ]);
    // Root keeps its single top-level child A (children were not scattered up).
    expect(next.document.model.children.map((c) => c.id)).toEqual(["A"]);
    // The caret lands at the merge boundary on A.
    expect(next.view.activeNodeId).toBe("A");
    expect(next.view.cursorPos).toBe(1);
  });
});

describe("FINDING 2 (Alloy DuplicateIdHazard): parseContent normalizes ids to a unique-id tree", () => {
  it("reassigns duplicated ids on load so removeNode targets exactly one node", () => {
    // External JSON (from the DB / PUT /api/notes/:id) with a duplicated id.
    const hostile = serializeModel(
      mk("root", "Root", [mk("dup", "First"), mk("dup", "Second")])
    );
    const model = parseContent(hostile, "ignored");

    // After normalization every id in the tree is unique.
    const all = ids(model);
    expect(new Set(all).size).toBe(all.length);

    // removeNode now unambiguously removes exactly the addressed node.
    const firstDupId = model.children[0].id;
    const after = removeNode(model, firstDupId);
    expect(after.children.map((c) => c.text)).toEqual(["Second"]);
    expect(findNode(after, firstDupId)).toBeNull();
  });

  it("drops malformed children instead of accepting a non-tree shape", () => {
    const model = parseContent(
      JSON.stringify({
        id: "root",
        text: "Root",
        children: [{ id: "ok", text: "OK", children: [] }, 42, null, { text: "no children" }],
      }),
      "ignored"
    );
    expect(model.children.map((c) => c.text)).toEqual(["OK"]);
  });
});

describe("FINDING 3 (TLA+/Z3 undo_redo): replace reconciles a dangling selection", () => {
  it("editorReducer('replace') never leaves the active id pointing at an absent node", () => {
    // Simulate undo restoring a document that lacks the still-active node.
    const restoredDoc = { model: mk("root", "Root", []), clipboard: null };
    const dangling: EditorState = {
      document: restoredDoc,
      view: {
        activeNodeId: "ghost", // created by an edit the undo rolled back
        editing: false,
        editingText: "",
        cursorPos: 0,
        selectionEnd: 0,
      },
    };
    expect(findNode(restoredDoc.model, "ghost")).toBeNull();

    // The reducer folds reconcileView into the replace path, so the invariant
    // "active node exists" is enforced without a separate caller step.
    const next = editorReducer(dangling, { type: "replace", state: dangling });
    expect(next.view.activeNodeId).toBe("root");
    expect(findNode(next.document.model, next.view.activeNodeId!)).not.toBeNull();
  });
});

describe("FINDING 4 (execution probe): node identity is stable on split", () => {
  it("Enter at the start of a node keeps its id/text/children and inserts a blank line above", () => {
    const model = mk("root", "Root", [mk("P", "Parent", [mk("C", "Child")])]);
    const before = ids(model);
    const next = editorReducer(state(model, "P"), { type: "enter", pos: 0 });

    // P keeps its id, its text and its subtree — identity does not migrate.
    const p = findNode(next.document.model, "P")!;
    expect(p.text).toBe("Parent");
    expect(p.children.map((c) => c.id)).toEqual(["C"]);

    // A brand-new EMPTY node is inserted before P (the "blank line above").
    const newIds = ids(next.document.model).filter((id) => !before.includes(id));
    expect(newIds).toHaveLength(1);
    const inserted = findNode(next.document.model, newIds[0])!;
    expect(inserted.text).toBe("");
    expect(inserted.children).toHaveLength(0);
    expect(next.document.model.children.map((c) => c.id)).toEqual([newIds[0], "P"]);

    // The caret stays on the original node P (with its content).
    expect(next.view.activeNodeId).toBe("P");
    expect(next.view.cursorPos).toBe(0);
  });
});
