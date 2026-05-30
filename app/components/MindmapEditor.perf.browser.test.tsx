import { describe, it, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import MindmapEditor, { type MindmapTestApi } from "./MindmapEditor";
import type { MindMapModel } from "../domain/model";

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
    if (Date.now() - start > 8000) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 30));
  }
}

// Wait past the next paint so the (passive) redraw effect has run.
const flush = () =>
  new Promise<void>((res) =>
    requestAnimationFrame(() => requestAnimationFrame(() => res()))
  );

beforeEach(() => {
  const style = document.createElement("style");
  style.textContent = `
    [data-testid="mm-canvas"] {
      position: absolute; left: 0; top: 0; width: 800px; height: 560px;
    }
  `;
  document.head.appendChild(style);
});

// Measures the real per-operation cost in the browser, dominated by the Konva
// main-canvas redraw (it rebuilds every node + re-measures text widths each
// time). Numbers are logged; assertions are deliberately generous so the test
// guards against catastrophic regressions without being machine-sensitive.
describe("MindmapEditor browser performance", () => {
  for (const SIZE of [50, 200]) {
    it(`char input & cursor movement in a ${SIZE}-node tree`, { timeout: 60000 }, async ({ annotate }) => {
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
      await userEvent.click(canvas, {
        position: { x: Math.round(point.x), y: Math.round(point.y) },
      });
      await waitFor(
        () =>
          (document.activeElement as HTMLElement | null)?.tagName === "TEXTAREA"
      );
      await flush();

      const N = 8;

      // --- character input ---
      api().resetRedrawStats();
      for (let k = 0; k < N; k++) {
        await userEvent.keyboard("a");
        await flush();
      }
      const ins = api().getRedrawStats();
      const perInsert = ins.redrawTotalMs / Math.max(1, ins.redrawCount);

      // --- cursor movement (node navigation) ---
      api().resetRedrawStats();
      for (let k = 0; k < N; k++) {
        await userEvent.keyboard("{ArrowDown}");
        await flush();
      }
      const mv = api().getRedrawStats();
      const perMove = mv.redrawTotalMs / Math.max(1, mv.redrawCount);

      const insDraw = ins.redrawDrawMs / Math.max(1, ins.redrawCount);
      const summary =
        `[perf][${SIZE} nodes] redraw — char input: ${perInsert.toFixed(2)} ms/keystroke` +
        ` (draw ${insDraw.toFixed(2)} ms) | cursor move: ${perMove.toFixed(2)} ms/move`;
      // Surfaced in the reporter (browser console isn't forwarded to the terminal).
      await annotate(summary, "perf");

      // NOTE: this is a measurement, not a tight budget. The main redraw
      // rebuilds every node and re-measures text widths on every keystroke, so
      // the cost grows with tree size (≈0.6 ms/node observed). The ceiling here
      // only catches a total blow-up; see the logged numbers for the real cost.
      expect(ins.redrawCount).toBeGreaterThan(0);
      expect(mv.redrawCount).toBeGreaterThan(0);
      expect(perInsert).toBeLessThan(3000);
      expect(perMove).toBeLessThan(3000);
    });
  }
});
