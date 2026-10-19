/**
 * Remote edits keep the document invariants for any tree and any target:
 * ids stay unique, a root always exists, only roots carry a position, and the
 * outline lists every node exactly once.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { MindMapDocument, MindMapModel } from "../domain/model";
import { allIds, expectUniqueIds, modelArb, pick, sequentialIds } from "../domain/model.arb";
import { applyNoteEdit, documentToOutline, type NoteEdit } from "./noteEdits";

function nestedPositions(doc: MindMapDocument): number {
  const walk = (n: MindMapModel): number => n.children.reduce((s, c) => s + (c.position ? 1 : 0) + walk(c), 0);
  return doc.roots.reduce((s, r) => s + walk(r), 0);
}

const snippet = (k: number): MindMapModel[] =>
  Array.from({ length: k }, (_, i) => ({ id: `md${i}`, text: `x${i}`, children: [{ id: `md${i}c`, text: "c", children: [] }] }));

const editArb = fc
  .tuple(modelArb, fc.nat(), fc.integer({ min: 0, max: 4 }), fc.integer({ min: 1, max: 3 }))
  .map(([model, n, kind, k]): { model: MindMapDocument; edit: NoteEdit } => {
    const nodeId = pick(allIds(model), n);
    const edits: NoteEdit[] = [
      { kind: "addNodes", parentId: nodeId, nodes: snippet(k) },
      { kind: "addNodes", afterId: nodeId, nodes: snippet(k) },
      { kind: "addNodes", nodes: snippet(k) },
      { kind: "updateNode", nodeId, text: "edited", checked: n % 2 === 0 },
      { kind: "deleteNode", nodeId },
    ];
    return { model, edit: edits[kind] };
  });

describe("applyNoteEdit", () => {
  it("keeps ids unique, a root, and positions on roots only", () => {
    fc.assert(
      fc.property(editArb, ({ model, edit }) => {
        const r = applyNoteEdit(model, edit, sequentialIds());
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expectUniqueIds(r.document);
        expect(r.document.roots.length).toBeGreaterThan(0);
        expect(nestedPositions(r.document)).toBe(0);
        for (const id of r.nodeIds) expect(allIds(r.document)).toContain(id);
      })
    );
  });

  it("outlines every node exactly once", () => {
    fc.assert(
      fc.property(modelArb, (model) => {
        const outline = documentToOutline(model);
        for (const id of allIds(model)) {
          expect(outline.split(`{id=${id}}`).length - 1).toBe(1);
        }
      })
    );
  });
});
