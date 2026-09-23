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
  type MindMapDocument,
  type MindMapModel,
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

/**
 * The ids that still name a node, resolved once (`Map` preserves the ids'
 * relative order) — every test below that needs "which of these ids exist,
 * and what do they look like" shares this single walk instead of each
 * re-running `findNode` per id, sometimes more than once.
 */
function existingNodes(doc: MindMapDocument, ids: readonly string[]): Map<string, MindMapModel> {
  const found = new Map<string, MindMapModel>();
  for (const id of ids) {
    if (found.has(id)) continue;
    const n = findNode(doc, id);
    if (n) found.set(id, n);
  }
  return found;
}

describe("nextMultiSelection", () => {
  it("with no modifier held, always clears (regardless of doc/ids/active node)", () => {
    const withActiveArb = docAndIdsArb.chain(({ doc, ids }) =>
      fc.constantFrom(null, ...ids).map((activeId) => ({ doc, ids, activeId }))
    );
    fc.assert(
      fc.property(withActiveArb, fc.string(), ({ doc, ids, activeId }, clickedId) => {
        expect(
          nextMultiSelection(doc, activeId, ids, clickedId, {
            shiftKey: false,
            toggleKey: false,
          })
        ).toEqual([]);
      })
    );
  });

  it("shift-click range doesn't depend on which end is the anchor, and selects exactly the ids between anchor and clicked in flat order", () => {
    fc.assert(
      fc.property(modelArb, fc.nat(), fc.nat(), (doc, aIdx, cIdx) => {
        const order = getFlatOrder(doc);
        const indexOf = new Map(order.map((id, i) => [id, i]));
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

        const lo = Math.min(indexOf.get(anchor)!, indexOf.get(clicked)!);
        const hi = Math.max(indexOf.get(anchor)!, indexOf.get(clicked)!);
        const forwardSet = new Set(forward);
        // Independent of the slice the implementation itself takes: an id
        // belongs in the range iff its OWN flat-order position falls between
        // the two endpoints — which also pins down contiguity and order,
        // since `order` is already flat order.
        for (const id of order) {
          expect(forwardSet.has(id)).toBe(indexOf.get(id)! >= lo && indexOf.get(id)! <= hi);
        }
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

        const nodes = existingNodes(doc, ids);
        const eligible = [...nodes.values()].filter((n) => supportsCheckbox(n.type ?? "text"));
        expect(new Set([...plain, ...tasked])).toEqual(new Set(eligible.map((n) => n.id)));

        for (const id of plain) expect(nodes.get(id)!.checked).toBeUndefined();
        for (const id of tasked) expect(nodes.get(id)!.checked).not.toBeUndefined();
      })
    );
  });
});

describe("planGroupCheckToggle", () => {
  it("agrees with findNode/supportsCheckbox on which ids qualify, and moves a mixed group to done, an all-done group to open", () => {
    fc.assert(
      fc.property(docAndIdsArb, fc.boolean(), ({ doc, ids }, requireExisting) => {
        const nodes = existingNodes(doc, ids);
        const eligible = [...nodes.values()]
          .filter((n) => supportsCheckbox(n.type ?? "text"))
          .filter((n) => !requireExisting || n.checked !== undefined);

        const result = planGroupCheckToggle(doc, ids, { requireExisting });
        if (eligible.length === 0) {
          expect(result).toBeNull();
          return;
        }
        expect(result!.nodeIds).toEqual(eligible.map((n) => n.id));
        // Stated independently of nextCheckedStateForGroup's own formula, so
        // a bug in that shared helper can't cancel out against this check.
        const allAlreadyDone = eligible.every((n) => n.checked === true);
        expect(result!.checked).toBe(!allAlreadyDone);
      })
    );
  });
});

describe("planGroupCollapse", () => {
  it("agrees with findNode on which ids can fold, and folds a mixed group, unfolds an all-folded group", () => {
    fc.assert(
      fc.property(docAndIdsArb, ({ doc, ids }) => {
        const nodes = existingNodes(doc, ids);
        const parents = [...nodes.values()].filter((n) => n.children.length > 0);

        const result = planGroupCollapse(doc, ids);
        if (parents.length === 0) {
          expect(result).toBeNull();
          return;
        }
        expect(result!.nodeIds).toEqual(parents.map((n) => n.id));
        // Stated as "some parent is still open" rather than the implementation's
        // own `!every(...)` line, so a bug there wouldn't just mirror through.
        const someStillOpen = parents.some((n) => n.collapsed !== true);
        expect(result!.collapsed).toBe(someStillOpen);
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

        // One DFS builds the whole parent map, so checking every existing
        // id's ancestor chain below is O(depth) lookups each rather than a
        // fresh tree walk per id.
        const parentOf = new Map<string, string | null>();
        (function record(nodes: MindMapModel[], parent: string | null) {
          for (const n of nodes) {
            parentOf.set(n.id, parent);
            record(n.children, n.id);
          }
        })(doc.roots, null);

        const existing = new Set(ids.filter((id) => parentOf.has(id)));
        const hasSelectedAncestor = (id: string): boolean => {
          let p = parentOf.get(id) ?? null;
          while (p) {
            if (existing.has(p)) return true;
            p = parentOf.get(p) ?? null;
          }
          return false;
        };

        // Membership: exactly the existing ids without a selected ancestor.
        for (const id of existing) {
          expect(resultSet.has(id)).toBe(!hasSelectedAncestor(id));
        }
        for (const id of result) expect(existing.has(id)).toBe(true);

        // Order: the document's own DFS order, restricted to the result.
        const docOrder = allIds(doc);
        expect(result).toEqual(docOrder.filter((id) => resultSet.has(id)));

        // Idempotent: the outermost set has nothing left to collapse further.
        expect(outermostBranches(doc, result)).toEqual(result);
      })
    );
  });
});
