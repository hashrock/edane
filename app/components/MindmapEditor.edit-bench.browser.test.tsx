import { describe, it, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import MindmapEditor, { type MindmapTestApi } from "./MindmapEditor";
import type { MindMapModel } from "../domain/model";

/**
 * Large-tree edit-operation benchmark (headless Chromium).
 *
 * The existing `*.perf.browser.test.tsx` covers small trees (50 / 200 nodes)
 * and only two operations. This file scales up to ~1000 nodes — the size at
 * which the per-keystroke Konva redraw (it rebuilds every node and re-measures
 * text widths on every change) starts to dominate — and exercises the full set
 * of structural edit operations, not just character input:
 *
 *   - character input   (typeText commit + full redraw)
 *   - sibling add        (Enter → new node + redraw)
 *   - node delete        (Backspace on an empty node + redraw)
 *   - cursor navigation  (ArrowDown between nodes)
 *
 * Numbers are surfaced via `annotate(...)` (the browser console isn't forwarded
 * to the terminal). Assertions are deliberately generous: they only guard
 * against a catastrophic (e.g. O(n^2)) blow-up, not machine-to-machine noise.
 */

/** Build a 4-ary tree (breadth-first) with `count` nodes. Root id is "n0". */
function buildTree(count: number): MindMapModel {
  let i = 0;
  const make = (): MindMapModel => {
    const id = `n${i++}`;
    return { id, text: id, children: [] };
  };
  const root = make();
  const queue: MindMapModel[] = [root];
  while (i < count) {
    const parent = queue.shift()!;
    for (let b = 0; b < 4 && i < count; b++) {
      const child = make();
      parent.children.push(child);
      queue.push(child);
    }
  }
  return root;
}

function api(): MindmapTestApi {
  const a = window.__mindmapTest;
  if (!a) throw new Error("__mindmapTest not exposed yet");
  return a;
}

async function waitFor<T>(fn: () => T | null | undefined | false): Promise<T> {
  const start = Date.now();
  for (;;) {
    try {
      const v = fn();
      if (v) return v as T;
    } catch {
      // not ready
    }
    if (Date.now() - start > 10000) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 30));
  }
}

// Wait past the next paint so the (passive) redraw effect has run.
const flush = () =>
  new Promise<void>((res) =>
    requestAnimationFrame(() => requestAnimationFrame(() => res()))
  );

/** Average redraw cost per operation from a stats snapshot. */
function perOp(s: { redrawTotalMs: number; redrawCount: number; redrawDrawMs: number }) {
  return {
    perOpMs: s.redrawTotalMs / Math.max(1, s.redrawCount),
    perDrawMs: s.redrawDrawMs / Math.max(1, s.redrawCount),
    count: s.redrawCount,
  };
}

beforeEach(() => {
  const style = document.createElement("style");
  style.textContent = `
    [data-testid="mm-canvas"] {
      position: absolute; left: 0; top: 0; width: 800px; height: 560px;
    }
  `;
  document.head.appendChild(style);
});

describe("MindmapEditor large-tree edit benchmark", () => {
  // Primary target is ~1000 nodes; 500 is kept as a scaling reference point.
  for (const SIZE of [500, 1000]) {
    it(`edit operations in a ${SIZE}-node tree`, { timeout: 120000 }, async ({ annotate }) => {
      render(
        <MindmapEditor
          initialContent={JSON.stringify(buildTree(SIZE))}
          initialTitle="Root"
        />
      );

      // Wait until Konva is ready and the first redraw has completed.
      const point = await waitFor(() => api().getNodeClickPoint("n0"));
      await waitFor(() => api().getRedrawStats().redrawCount > 0);

      const canvas = document.querySelector<HTMLElement>(
        '[data-testid="mm-canvas"]'
      )!;
      // Click the root, then Space to drop into edit mode.
      await userEvent.click(canvas, {
        position: { x: Math.round(point.x), y: Math.round(point.y) },
      });
      await waitFor(() => api().getActiveNodeId() === "n0");
      await userEvent.keyboard("[Space]");
      await waitFor(() => api().getSelection().editing === true);
      await flush();

      const N = 8;

      // --- 1. character input (typeText commit + full redraw) ---
      api().resetRedrawStats();
      for (let k = 0; k < N; k++) {
        await userEvent.keyboard("a");
        await flush();
      }
      const charInput = perOp(api().getRedrawStats());

      // --- 2. sibling add (End → Enter creates an empty sibling & focuses it) ---
      // Each Enter adds a node and lands the caret in the fresh empty node, so
      // the next Enter chains another sibling — N real insertions.
      const baseCount = countNodes(api().getModel());
      api().resetRedrawStats();
      for (let k = 0; k < N; k++) {
        await userEvent.keyboard("{End}{Enter}");
        await flush();
      }
      await waitFor(() => countNodes(api().getModel()) >= baseCount + N);
      const siblingAdd = perOp(api().getRedrawStats());

      // --- 3. node delete (Backspace at pos 0 of an empty node removes it) ---
      // We're currently sitting in the last empty sibling just added; Backspace
      // deletes it and moves to the previous (also empty) sibling, so N deletes.
      api().resetRedrawStats();
      for (let k = 0; k < N; k++) {
        await userEvent.keyboard("{Home}{Backspace}");
        await flush();
      }
      const nodeDelete = perOp(api().getRedrawStats());

      // --- 4. cursor navigation between nodes ---
      api().resetRedrawStats();
      for (let k = 0; k < N; k++) {
        await userEvent.keyboard("{ArrowDown}");
        await flush();
      }
      const navStats = api().getRedrawStats();
      const perMove = navStats.redrawTotalMs / Math.max(1, navStats.redrawCount);

      const summary =
        `[edit-bench][${SIZE} nodes] redraw/op — ` +
        `char input: ${charInput.perOpMs.toFixed(2)} ms (draw ${charInput.perDrawMs.toFixed(2)}) | ` +
        `sibling add: ${siblingAdd.perOpMs.toFixed(2)} ms (draw ${siblingAdd.perDrawMs.toFixed(2)}) | ` +
        `node delete: ${nodeDelete.perOpMs.toFixed(2)} ms (draw ${nodeDelete.perDrawMs.toFixed(2)}) | ` +
        `cursor move: ${perMove.toFixed(2)} ms`;
      await annotate(summary, "perf");

      // Sanity: every operation category produced redraws...
      expect(charInput.count).toBeGreaterThan(0);
      expect(siblingAdd.count).toBeGreaterThan(0);
      expect(nodeDelete.count).toBeGreaterThan(0);
      expect(navStats.redrawCount).toBeGreaterThan(0);
      // ...and none blew up catastrophically (generous ceiling, not a budget).
      expect(charInput.perOpMs).toBeLessThan(5000);
      expect(siblingAdd.perOpMs).toBeLessThan(5000);
      expect(nodeDelete.perOpMs).toBeLessThan(5000);
      expect(perMove).toBeLessThan(5000);
    });
  }
});

/** Total node count in the tree. */
function countNodes(node: MindMapModel): number {
  let n = 1;
  for (const c of node.children) n += countNodes(c);
  return n;
}
