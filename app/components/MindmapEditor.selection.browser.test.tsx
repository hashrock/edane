import { describe, it, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import MindmapEditor, { type MindmapTestApi } from "./MindmapEditor";
import type { MindMapModel } from "../domain/model";

// DFS order: root, a, b
const MODEL: MindMapModel = {
  id: "root",
  text: "Root",
  children: [
    { id: "a", text: "Alpha", children: [] },
    { id: "b", text: "Bravo", children: [] },
  ],
};

// A single-child chain: the layout gives the only child the *same* Y as its
// parent, which is what made a tiny post-click drag re-target the parent.
const CHAIN_MODEL: MindMapModel = {
  id: "root",
  text: "Root",
  children: [{ id: "only", text: "Only", children: [] }],
};

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
    if (Date.now() - start > 5000) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 30));
  }
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

describe("MindmapEditor single-node selection", () => {
  it("starts with the root selected and moves the single selection with arrows", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );

    // Exactly one node is always selected; the root starts active.
    await waitFor(() => api().getActiveNodeId() === "root");
    await waitFor(() => api().getRedrawStats().redrawCount > 0);

    const point = await waitFor(() => api().getNodeClickPoint("a"));
    const canvas = document.querySelector<HTMLElement>(
      '[data-testid="mm-canvas"]'
    )!;
    // Click selects node "a" (selection mode, not editing).
    await userEvent.click(canvas, {
      position: { x: Math.round(point.x), y: Math.round(point.y) },
    });
    await waitFor(() => api().getActiveNodeId() === "a");
    await waitFor(() => api().getSelection().editing === false);

    // Arrow keys move the single selection, never extending it.
    await userEvent.keyboard("{ArrowDown}");
    await waitFor(() => api().getActiveNodeId() === "b");

    await userEvent.keyboard("{ArrowUp}");
    await waitFor(() => api().getActiveNodeId() === "a");

    // Escape leaves a node selected (no "nothing selected" state).
    await userEvent.keyboard("{Escape}");
    expect(api().getActiveNodeId()).toBe("a");
  });

  it("keeps the clicked node selected when the pointer jitters a few pixels", async () => {
    render(
      <MindmapEditor
        initialContent={JSON.stringify(CHAIN_MODEL)}
        initialTitle="Root"
      />
    );

    await waitFor(() => api().getActiveNodeId() === "root");
    await waitFor(() => api().getRedrawStats().redrawCount > 0);

    const point = await waitFor(() => api().getNodeClickPoint("only"));
    const canvas = document.querySelector<HTMLElement>(
      '[data-testid="mm-canvas"]'
    )!;

    // Konva binds its pointer handlers to the inner canvas; dispatch native
    // mouse events there so the stage's mousedown/mousemove/mouseup fire.
    const target =
      canvas.querySelector("canvas") ?? (canvas as unknown as HTMLElement);
    const fire = (type: string, x: number, y: number) =>
      target.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
        })
      );

    // Press on the child, move a handful of pixels (crossing the drag
    // threshold), then release. The child shares its parent's Y, so the old
    // "closest node by Y" drag-select would have handed selection to the root.
    fire("mousedown", point.x, point.y);
    fire("mousemove", point.x + 6, point.y + 5);
    fire("mouseup", point.x + 6, point.y + 5);

    await waitFor(() => api().getActiveNodeId() === "only");
    expect(api().getActiveNodeId()).toBe("only");
  });
});
