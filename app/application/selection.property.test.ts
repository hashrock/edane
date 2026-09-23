/**
 * selection.ts pilots multi-select gestures straight from the document tree
 * (see its file doc), but its own tests (selection.test.ts) only exercise a
 * few hand-built trees. These properties total the same contracts over
 * arbitrary trees and id subsets — including stale ("ghost") ids, since a
 * selection is read from a possibly-outdated view — so a future edit that
 * narrows a case those fixtures happen not to cover still gets caught.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  findNode,
  getFlatOrder,
  locateNode,
  nextCheckedStateForGroup,
  subtreeIds,
  type MindMapDocument,
} from "../domain/model";
import { allIds, modelArb, pick } from "../domain/model.arb";
import { supportsCheckbox } from "./nodeUtils";
import {
  checkboxMenuTargets,
  nextMultiSelection,
  outermostBranches,
  planGroupCheckToggle,
  planGroupCollapse,
} from "./selection";

/** A document's ids, shuffled, plus a couple of ids that don't exist in it. */
const idsArb = (doc: MindMapDocument) =>
  fc
    .tuple(
      fc.shuffledSubarray(allIds(doc)),
      fc.array(fc.constantFrom("ghost-1", "ghost-2"), { maxLength: 2 })
    )
    .map(([existing, ghosts]) => [...existing, ...ghosts]);

const docAndIdsArb = modelArb.chain((doc) => idsArb(doc).map((ids) => ({ doc, ids })));

describe("nextMultiSelection", () => {
  it("with no modifier held, always clears (regardless of doc/ids)", () => {
    fc.assert(
      fc.property(docAndIdsArb, fc.string(), ({ doc, ids }, clickedId) => {
        const current = ids;
        for (const activeId of [null, ...ids]) {
          expect(
            nextMultiSelection(doc, activeId, current, clickedId, {
              shiftKey: false,
              toggleKey: false,
            })
          ).toEqual([]);
        }
      })
    );
  });

  it("shift-click range doesn't depend on which end is the anchor, and is exactly the flat-order slice between the two", () => {
    fc.assert(
      fc.property(modelArb, fc.nat(), fc.nat(), (doc, aIdx, cIdx) => {
        const order = getFlatOrder(doc);
        const anchor = pick(order, aIdx);
        const clicked = pick(order, cIdx);
        const forward = nextMultiSelection(doc, anchor, [], clicked, {
          shiftKey: true,
          toggleKey: false,
        });
        const backward = nextMultiSelection(doc, clicked, [], anchor, {
          shiftKey: true,
          toggleKey: false,
        });
        expect(forward).toEqual(backward);

        const lo = Math.min(order.indexOf(anchor), order.indexOf(clicked));
        const hi = Math.max(order.indexOf(anchor), order.indexOf(clicked));
        expect(forward).toEqual(order.slice(lo, hi + 1));
      })
    );
  });

  it("ctrl/cmd-click toggling the same id twice is a no-op on a non-empty selection", () => {
    fc.assert(
      fc.property(modelArb, fc.nat(), fc.nat(), (doc, cIdx, curIdx) => {
        const order = getFlatOrder(doc);
        const clickedId = pick(order, cIdx);
        // `current` holds a DIFFERENT id, kept fixed and never itself
        // toggled, so it can never be emptied by the two clicks below — which
        // would otherwise trip nextMultiSelection's "empty current falls back
        // to the active node" rule (see its doc comment) and break the
        // round trip. Skips the (rare) single-node doc, where no other id
        // exists to hold current non-empty.
        const pool = order.filter((id) => id !== clickedId);
        fc.pre(pool.length > 0);
        const current = [pick(pool, curIdx)];
        const activeId = current[0];
        const once = nextMultiSelection(doc, activeId, current, clickedId, {
          shiftKey: false,
          toggleKey: true,
        });
        const twice = nextMultiSelection(doc, activeId, once, clickedId, {
          shiftKey: false,
          toggleKey: true,
        });
        expect(new Set(twice)).toEqual(new Set(current));
      })
    );
  });
});

describe("checkboxMenuTargets", () => {
  it("plain/tasked partition exactly the ids that exist and support a checkbox", () => {
    fc.assert(
      fc.property(docAndIdsArb, ({ doc, ids }) => {
        const { plain, tasked } = checkboxMenuTargets(doc, ids);
        expect(plain.filter((id) => tasked.includes(id))).toEqual([]);

        const eligible = ids.filter((id) => {
          const n = findNode(doc, id);
          return !!n && supportsCheckbox(n.type ?? "text");
        });
        expect(new Set([...plain, ...tasked])).toEqual(new Set(eligible));

        for (const id of plain) expect(findNode(doc, id)!.checked).toBeUndefined();
        for (const id of tasked) expect(findNode(doc, id)!.checked).not.toBeUndefined();
      })
    );
  });
});

describe("planGroupCheckToggle", () => {
  it("agrees with findNode/supportsCheckbox/nextCheckedStateForGroup on which ids qualify and the target state", () => {
    fc.assert(
      fc.property(docAndIdsArb, fc.boolean(), ({ doc, ids }, requireExisting) => {
        const eligible = ids
          .map((id) => findNode(doc, id))
          .filter((n): n is NonNullable<typeof n> => !!n && supportsCheckbox(n.type ?? "text"))
          .filter((n) => !requireExisting || n.checked !== undefined);

        const result = planGroupCheckToggle(doc, ids, { requireExisting });
        if (eligible.length === 0) {
          expect(result).toBeNull();
          return;
        }
        expect(result!.nodeIds).toEqual(eligible.map((n) => n.id));
        expect(result!.checked).toBe(nextCheckedStateForGroup(eligible.map((n) => n.checked)));
      })
    );
  });
});

describe("planGroupCollapse", () => {
  it("agrees with findNode/nextCheckedStateForGroup's shape on which ids can fold and the target state", () => {
    fc.assert(
      fc.property(docAndIdsArb, ({ doc, ids }) => {
        const parents = ids
          .map((id) => findNode(doc, id))
          .filter((n): n is NonNullable<typeof n> => !!n && n.children.length > 0);

        const result = planGroupCollapse(doc, ids);
        if (parents.length === 0) {
          expect(result).toBeNull();
          return;
        }
        expect(result!.nodeIds).toEqual(parents.map((n) => n.id));
        expect(result!.collapsed).toBe(!parents.every((n) => n.collapsed === true));
      })
    );
  });
});

describe("outermostBranches", () => {
  it("keeps exactly the existing selected ids that have no selected ancestor, in document order, idempotently", () => {
    fc.assert(
      fc.property(docAndIdsArb, ({ doc, ids }) => {
        const result = outermostBranches(doc, ids);
        const resultSet = new Set(result);
        expect(resultSet.size).toBe(result.length); // no duplicates

        const existing = new Set(ids.filter((id) => findNode(doc, id)));
        const selectedAncestor = (id: string): boolean => {
          let p = locateNode(doc, id)?.parent ?? null;
          while (p) {
            if (existing.has(p.id)) return true;
            p = locateNode(doc, p.id)?.parent ?? null;
          }
          return false;
        };

        // Membership: exactly the existing ids without a selected ancestor.
        for (const id of existing) {
          expect(resultSet.has(id)).toBe(!selectedAncestor(id));
        }
        for (const id of result) expect(existing.has(id)).toBe(true);

        // Order: the document's own DFS order, restricted to the result.
        const docOrder = doc.roots.flatMap(subtreeIds);
        expect(result).toEqual(docOrder.filter((id) => resultSet.has(id)));

        // Idempotent: the outermost set has nothing left to collapse further.
        expect(outermostBranches(doc, result)).toEqual(result);
      })
    );
  });
});
