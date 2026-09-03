/**
 * The three visible-set traversals must agree. domain/model.ts defines the
 * visibility rule once (`visibleChildrenOf`: a collapsed node hides its whole
 * subtree) precisely so that keyboard navigation (`getFlatOrder`), the canvas
 * layout input (`flattenToNodes`) and the outline row list (`outlineRows`) —
 * three walks with three output shapes — cannot drift apart. This checks that
 * promise on random trees: same ids in the same order, same depths, hidden
 * descendants absent everywhere, and the per-row facts (hasChildren,
 * childCount, collapsed, position) read straight off the model.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { findNode, getFlatOrder, getNodeDepths } from "../domain/model";
import { modelAndNodeArb, modelArb } from "../domain/model.arb";
import { outlineRows } from "./outline";
import { flattenToNodes } from "./nodeUtils";

describe("getFlatOrder / outlineRows / flattenToNodes", () => {
  it("list the same ids in the same order, with top-level depth 0 = getNodeDepths − 1", () => {
    fc.assert(
      fc.property(modelArb, (model) => {
        const order = getFlatOrder(model);
        const rows = outlineRows(model);
        const flat = flattenToNodes(model);
        expect(rows.map((r) => r.node.id)).toEqual(order);
        expect(flat.map((n) => n.id)).toEqual(order);

        const depths = getNodeDepths(model);
        for (const r of rows) expect(r.depth).toBe(depths.get(r.node.id)! - 1);
        for (const n of flat) expect(n.depth).toBe(depths.get(n.id)! - 1);
      })
    );
  });

  it("report each node's own facts: hasChildren/childCount from the model, children only when expanded, position only at depth 0", () => {
    fc.assert(
      fc.property(modelArb, (model) => {
        for (const r of outlineRows(model)) {
          const m = findNode(model, r.node.id)!;
          expect(r.node).toBe(m); // the row carries the model node itself
          expect(r.hasChildren).toBe(m.children.length > 0);
          expect(r.collapsed).toBe(!!m.collapsed);
        }
        for (const n of flattenToNodes(model)) {
          const m = findNode(model, n.id)!;
          expect(n.childCount).toBe(m.children.length);
          expect(n.collapsed).toBe(!!m.collapsed);
          expect(n.children).toEqual(m.collapsed ? [] : m.children.map((c) => c.id));
          expect(n.type).toBe(m.type ?? "text");
          if (n.depth === 0) expect(n.position).toEqual(m.position);
          else expect(n.position).toBeUndefined();
          expect(n.width).toBeGreaterThanOrEqual(0); // an empty text measures 0 wide
          expect(n.height).toBeGreaterThan(0);
        }
      })
    );
  });

  it("flattenToNodes keeps the same ids whichever node is being edited with whatever buffer", () => {
    fc.assert(
      fc.property(modelAndNodeArb, fc.string({ maxLength: 80 }), ({ model, nodeId: id }, buffer) => {
        const plain = flattenToNodes(model).map((x) => x.id);
        expect(flattenToNodes(model, { id, text: buffer }).map((x) => x.id)).toEqual(plain);
      })
    );
  });
});
