import { describe, it, expect } from "vitest";
import {
  NEW_ID,
  allIds,
  enabledEvents,
  flatIds,
  specStep,
  type SpecNode,
  type SpecState,
} from "./editorSpec.testHelpers";
import { prng } from "./graphExplorer.testHelpers";

/**
 * The graph-based e2e test is only as good as its oracle, so the spec gets
 * its own checks: random walks over the spec ALONE (no browser), asserting
 * structural invariants and the CLAUDE.md rules the spec is meant to encode.
 * If one of these fails, the spec is wrong — not the editor.
 */

const INITIAL: SpecState = {
  roots: [
    {
      id: "a",
      text: "alpha",
      children: [
        { id: "a1", text: "one", children: [] },
        { id: "a2", text: "two", children: [{ id: "a2x", text: "deep", children: [] }] },
      ],
    },
    { id: "b", text: "beta", children: [{ id: "b1", text: "b1", children: [] }] },
  ],
  activeId: "b",
  editing: false,
  caret: 0,
  selEnd: 0,
  lastChild: {},
};

/** Stand-in for the runner's id binding: give "?new" a fresh real id. */
function bindFresh(s: SpecState, n: number): SpecState {
  if (!allIds(s.roots).has(NEW_ID)) return s;
  const id = `n${n}`;
  const rename = (ns: SpecNode[]): SpecNode[] =>
    ns.map((x) => ({ ...x, id: x.id === NEW_ID ? id : x.id, children: rename(x.children) }));
  const swap = (v: string) => (v === NEW_ID ? id : v);
  return {
    ...s,
    roots: rename(s.roots),
    activeId: swap(s.activeId),
    lastChild: Object.fromEntries(Object.entries(s.lastChild).map(([k, v]) => [swap(k), swap(v)])),
  };
}

function findText(roots: SpecNode[], id: string): string | undefined {
  for (const n of roots) {
    if (n.id === id) return n.text;
    const t = findText(n.children, id);
    if (t !== undefined) return t;
  }
  return undefined;
}

function isAncestor(roots: SpecNode[], anc: string, id: string): boolean {
  const find = (ns: SpecNode[]): SpecNode | undefined => {
    for (const n of ns) {
      if (n.id === anc) return n;
      const hit = find(n.children);
      if (hit) return hit;
    }
  };
  const a = find(roots);
  return !!a && flatIds(a.children).includes(id);
}

/** Every state a seeded walk visits. */
function* walk(seed: number, steps: number): Generator<SpecState> {
  const rand = prng(seed);
  let s = INITIAL;
  for (let i = 0; i < steps; i++) {
    if (i % 40 === 0) s = INITIAL;
    yield s;
    const evs = enabledEvents(s);
    s = bindFresh(specStep(s, evs[Math.floor(rand() * evs.length)]), i);
  }
}

const SEEDS = Array.from({ length: 30 }, (_, i) => i + 1);

describe("editor spec (oracle of the graph-based e2e test)", () => {
  it("keeps the document well-formed: ≥1 root, unique ids, live focus, caret in range", () => {
    for (const seed of SEEDS) {
      for (const s of walk(seed, 400)) {
        const ids = flatIds(s.roots);
        expect(s.roots.length).toBeGreaterThan(0);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toContain(s.activeId);
        if (s.editing) {
          const len = findText(s.roots, s.activeId)!.length;
          for (const p of [s.caret, s.selEnd]) {
            expect(p).toBeGreaterThanOrEqual(0);
            expect(p).toBeLessThanOrEqual(len);
          }
        }
      }
    }
  });

  it("editing ↑/↓ never trap the caret (keyboard-escape invariant)", () => {
    for (const seed of SEEDS) {
      for (const s of walk(seed, 400)) {
        if (!s.editing) continue;
        const order = flatIds(s.roots);
        const i = order.indexOf(s.activeId);
        const up = specStep(s, { kind: "key", key: "up" });
        const down = specStep(s, { kind: "key", key: "down" });
        if (i > 0) expect(up.activeId).toBe(order[i - 1]);
        if (i < order.length - 1) expect(down.activeId).toBe(order[i + 1]);
      }
    }
  });

  it("selection ↑/↓ never descend into the active node's own subtree", () => {
    for (const seed of SEEDS) {
      for (const s of walk(seed, 400)) {
        if (s.editing) continue;
        for (const key of ["up", "down"] as const) {
          const t = specStep(s, { kind: "key", key });
          expect(isAncestor(s.roots, s.activeId, t.activeId)).toBe(false);
        }
      }
    }
  });

  it("selection ↓ only stops on the document's trailing edge, ↑ only on the first root", () => {
    for (const seed of SEEDS) {
      for (const s of walk(seed, 400)) {
        if (s.editing) continue;
        const stuckDown = specStep(s, { kind: "key", key: "down" }).activeId === s.activeId;
        // Trailing edge: the last root, its last child, that one's last child…
        let edge = s.roots[s.roots.length - 1];
        const trailing = [edge.id];
        while (edge.children.length > 0) {
          edge = edge.children[edge.children.length - 1];
          trailing.push(edge.id);
        }
        expect(stuckDown).toBe(trailing.includes(s.activeId));
        const stuckUp = specStep(s, { kind: "key", key: "up" }).activeId === s.activeId;
        expect(stuckUp).toBe(s.activeId === s.roots[0].id);
      }
    }
  });

  it("← then → is a round trip in selection mode", () => {
    for (const seed of SEEDS) {
      for (const s of walk(seed, 400)) {
        if (s.editing) continue;
        const left = specStep(s, { kind: "key", key: "left" });
        if (left.activeId === s.activeId) continue; // a root
        expect(specStep(left, { kind: "key", key: "right" }).activeId).toBe(s.activeId);
      }
    }
  });
});
