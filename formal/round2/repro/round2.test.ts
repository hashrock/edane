/**
 * Round 2 characterization tests — run against the REAL edane domain/application
 * code (no re-implementation). Unlike formal/repro/reproduce.test.ts (which pins
 * the FIXED round-1 behaviour), these pin the CURRENT, still-open round-2
 * findings, so they read as executable evidence for FINDINGS.md and will flip
 * (start failing) the moment a fix lands — a built-in check that the fix works.
 *
 * Run:  npx vitest run --config formal/round2/repro/vitest.config.ts
 */
import { describe, it, expect } from "vitest";
import type { MindMapModel } from "../../../app/domain/model";
import { getFlatOrder, findNode } from "../../../app/domain/model";
import {
  editorReducer,
  reconcileView,
  type EditorState,
  type ViewState,
} from "../../../app/application/editorReducer";

const mk = (
  id: string,
  text: string,
  children: MindMapModel[] = [],
  extra: Partial<MindMapModel> = {}
): MindMapModel => ({ id, text, children, ...extra });

const view = (over: Partial<ViewState> = {}): ViewState => ({
  activeNodeId: null,
  editing: true,
  editingText: "",
  cursorPos: 0,
  selectionEnd: 0,
  ...over,
});

describe("FINDING A (Z3 view_faithfulness / TLA+ EditUndo): undo leaves a stale edit buffer", () => {
  it("reconcileView keeps a live node's stale buffer + out-of-range caret", () => {
    // Restored document (what undo rolled back to): node A = "hi" (2 chars).
    const restoredDoc = { model: mk("root", "Root", [mk("A", "hi")]), clipboard: null };
    // The current view still edits A but its buffer/caret are the pre-undo
    // "hi there" / caret 8 — the view MindmapEditor.restoreDocument() passes in.
    const stale = view({ activeNodeId: "A", editingText: "hi there", cursorPos: 8, selectionEnd: 8 });

    const reconciled = reconcileView(stale, restoredDoc);
    // A exists, so reconcileView returns the SAME view — buffer/caret untouched.
    expect(reconciled).toBe(stale);
    expect(reconciled.editingText).toBe("hi there"); // != model "hi"
    const modelLen = findNode(restoredDoc.model, "A")!.text.length; // 2
    expect(reconciled.cursorPos).toBeGreaterThan(modelLen); // 8 > 2 : caret out of range
  });

  it("the next keystroke re-commits the stale buffer — the undo is silently reverted", () => {
    const restoredDoc = { model: mk("root", "Root", [mk("A", "hi")]), clipboard: null };
    const stale = view({ activeNodeId: "A", editingText: "hi there", cursorPos: 8, selectionEnd: 8 });

    // Undo/redo route through `replace`; the reconciled view keeps "hi there".
    const afterUndo = editorReducer(
      { document: restoredDoc, view: stale },
      { type: "replace", state: { document: restoredDoc, view: stale } }
    );
    expect(findNode(afterUndo.document.model, "A")!.text).toBe("hi"); // document really was restored
    expect(afterUndo.view.editingText).toBe("hi there"); // but the buffer shown to the user was not

    // The user, seeing "hi there" still on screen, types "!". The textarea value
    // (the stale buffer + the new char) is committed straight back to the model.
    const afterType = editorReducer(afterUndo, {
      type: "typeText",
      text: "hi there!",
      cursorPos: 9,
      selectionEnd: 9,
      commitModel: true,
    });
    // The rolled-back text is resurrected: undo achieved nothing.
    expect(findNode(afterType.document.model, "A")!.text).toBe("hi there!");
  });
});

describe("FINDING B (Z3 collapse_visibility / Alloy CollapseVisibility): edits hide content under a collapsed sibling", () => {
  it("Backspace-at-start merges into a COLLAPSED previous sibling, hiding the moved children", () => {
    // A is a folded section (collapsed, hides A1). B sits below it with children.
    const model = mk("root", "Root", [
      mk("A", "A", [mk("A1", "A1")], { collapsed: true }),
      mk("B", "B", [mk("B1", "B1"), mk("B2", "B2")]),
    ]);
    // A1 is already hidden; B/B1/B2 are visible.
    expect(getFlatOrder(model)).toEqual(["root", "A", "B", "B1", "B2"]);

    const next = editorReducer(
      { document: { model, clipboard: null }, view: view({ activeNodeId: "B" }) },
      { type: "backspaceAtStart" }
    );

    // B's text merged into A; B1/B2 became A's (hidden) children and dropped out
    // of navigation entirely.
    expect(findNode(next.document.model, "A")!.text).toBe("AB");
    expect(findNode(next.document.model, "A")!.children.map((c) => c.id)).toEqual([
      "A1",
      "B1",
      "B2",
    ]);
    const order = getFlatOrder(next.document.model);
    expect(order).toEqual(["root", "A"]); // B1, B2 silently vanished
    // The caret even lands on the collapsed node A.
    expect(next.view.activeNodeId).toBe("A");
  });

  it("Tab-indent under a COLLAPSED previous sibling hides the ACTIVE node itself", () => {
    const model = mk("root", "Root", [
      mk("A", "A", [mk("A1", "A1")], { collapsed: true }),
      mk("B", "B"),
    ]);
    const next = editorReducer(
      { document: { model, clipboard: null }, view: view({ activeNodeId: "B" }) },
      { type: "tab", shift: false }
    );
    // B is now a hidden child of collapsed A, yet it stays the active node.
    expect(next.view.activeNodeId).toBe("B");
    expect(getFlatOrder(next.document.model)).toEqual(["root", "A"]);
    expect(findNode(next.document.model, "A")!.children.map((c) => c.id)).toEqual(["A1", "B"]);
  });

  it("CONTROL: addChild expands a collapsed target first, so the new node stays visible", () => {
    const model = mk("root", "Root", [mk("A", "A", [mk("A1", "A1")], { collapsed: true })]);
    const next = editorReducer(
      { document: { model, clipboard: null }, view: view({ activeNodeId: "A", editing: false }) },
      { type: "addChild", nodeId: "A" }
    );
    // The insertion path (unlike merge/indent) un-collapses A — content stays visible.
    expect(findNode(next.document.model, "A")!.collapsed).toBeFalsy();
    const order = getFlatOrder(next.document.model);
    expect(order).toContain("A1");
    expect(order).toContain(next.view.activeNodeId); // the new child is navigable
  });
});
