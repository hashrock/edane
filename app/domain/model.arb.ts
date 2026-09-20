/**
 * fast-check arbitraries for the domain model, shared by the property-based
 * tests across layers (`*.property.test.ts`). Not imported by production code.
 *
 * Every generated document is well-formed by construction, so a property test
 * can take "unique ids, valid optional fields, ≥1 root, `position` only on
 * roots" as its precondition and check that an operation keeps it: ids are
 * assigned deterministically in DFS order (`n0`, `n1`, …) after the shape is
 * generated, which keeps shrunk counterexamples readable.
 */
import { expect } from "vitest";
import fc from "fast-check";
import {
  getFlatOrder,
  STORED_NODE_TYPES,
  subtreeIds,
  type IdSource,
  type MindMapDocument,
  type MindMapModel,
} from "./model";

/** Node text: short, ASCII, may be empty or contain spaces. */
export const nodeTextArb = fc.string({ maxLength: 12 });

/** A node before ids are assigned. */
type Draft = Omit<MindMapModel, "id" | "children"> & { children: Draft[] };

const positionArb = fc.record({
  x: fc.integer({ min: -2000, max: 2000 }),
  y: fc.integer({ min: -2000, max: 2000 }),
});

const draftArb: fc.Arbitrary<Draft> = fc.letrec<{ draft: Draft }>((tie) => ({
  draft: fc.record(
    {
      text: nodeTextArb,
      children: fc.oneof(
        { depthSize: "small", withCrossShrink: true },
        fc.constant([] as Draft[]),
        fc.array(tie("draft"), { maxLength: 3 })
      ),
      // Optional fields carry only the values the model actually stores
      // (`collapsed`/`bold` are absent-or-true, see normalizeTree).
      collapsed: fc.constant(true as const),
      type: fc.constantFrom(...STORED_NODE_TYPES),
      fontSize: fc.integer({ min: 8, max: 64 }),
      bold: fc.constant(true as const),
      linkTitle: fc.string({ maxLength: 8 }),
      favicon: fc.string({ maxLength: 8 }),
      checked: fc.boolean(),
      position: positionArb,
    },
    { requiredKeys: ["text", "children"] }
  ),
})).draft;

function assignIds(draft: Draft, next: () => string, isRoot: boolean): MindMapModel {
  const { children, position, ...rest } = draft;
  const node: MindMapModel = {
    id: next(),
    ...rest,
    children: children.map((c) => assignIds(c, next, false)),
  };
  // A canvas position is only meaningful on a root.
  if (isRoot && position) node.position = position;
  return node;
}

/** A single subtree (ids `n0`…), usable as a branch to paste or insert. */
export const nodeArb: fc.Arbitrary<MindMapModel> = draftArb.map((d) =>
  assignIds(d, sequentialIds("n"), true)
);

/**
 * A whole document: a title (never a node) with 1–3 roots, ids `n0`… in DFS
 * order.
 */
export const modelArb: fc.Arbitrary<MindMapDocument> = fc
  .record(
    {
      title: nodeTextArb,
      roots: fc.array(draftArb, { minLength: 1, maxLength: 3 }),
      // Persistence round-trips only an explicit `false` — `true` is the
      // implicit default and normalizeDocument drops it on parse (see
      // persistence.ts), so the generator must never produce a literal
      // `true` or the roundtrip property would see it vanish.
      multiRoot: fc.constant(false as const),
    },
    { requiredKeys: ["title", "roots"] }
  )
  .map(({ roots, ...rest }) => {
    const next = sequentialIds("n");
    return { ...rest, roots: roots.map((c) => assignIds(c, next, true)) };
  });

/** Every node id in the document, in DFS order (collapse ignored). */
export function allIds(doc: MindMapDocument): string[] {
  return doc.roots.flatMap(subtreeIds);
}

/** Every node id the UI can target — in a document that is every node. */
export const nodeIds = allIds;

/**
 * `collapsed` を落とした木。折りたたみは表示状態なので、木の中身だけを比べたい
 * 比較（畳まれていない状態を前提にする参照実装、折りたたみ以外の変化が無いこと
 * の確認）はこれを通してから行う。
 */
export function uncollapsed(node: MindMapModel): MindMapModel {
  const { collapsed: _collapsed, ...rest } = node;
  return { ...rest, children: node.children.map(uncollapsed) };
}

/** {@link uncollapsed} over every tree of a document. */
export function uncollapsedDocument(doc: MindMapDocument): MindMapDocument {
  return { ...doc, roots: doc.roots.map(uncollapsed) };
}

export function expectUniqueIds(doc: MindMapDocument): void {
  const ids = allIds(doc);
  expect(new Set(ids).size).toBe(ids.length);
}

/** A document together with one node id drawn from it. */
export const modelAndNodeArb = fc
  .tuple(modelArb, fc.nat())
  .map(([model, n]) => ({ model, nodeId: pick(nodeIds(model), n) }));

/** A document together with one VISIBLE node id — the only kind the UI can target. */
export const modelAndVisibleArb = fc
  .tuple(modelArb, fc.nat())
  .map(([model, n]) => ({ model, nodeId: pick(getFlatOrder(model), n) }));

/**
 * Pick an element by an unbounded natural (`fc.nat()`), so a test can draw
 * the model and its "which node" choices independently — unlike `chain`, this
 * keeps both shrinking.
 */
export function pick<T>(items: readonly T[], n: number): T {
  if (items.length === 0) throw new Error("pick: empty list");
  return items[n % items.length];
}

/**
 * Deterministic id supply (`new0`, `new1`, …) for the `nextId` parameter of
 * id-creating operations, so a test can predict every id an operation mints
 * and compare results exactly. The prefix must not collide with the `n…` ids
 * of generated trees.
 */
export function sequentialIds(prefix = "new"): IdSource {
  let i = 0;
  return () => `${prefix}${i++}`;
}
