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

describe("MindmapEditor Shift+Arrow multi-node selection", () => {
  it("extends and shrinks a selection to adjacent nodes", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );

    const point = await waitFor(() => api().getNodeClickPoint("root"));
    await waitFor(() => api().getRedrawStats().redrawCount > 0);

    const canvas = document.querySelector<HTMLElement>(
      '[data-testid="mm-canvas"]'
    )!;
    await userEvent.click(canvas, {
      position: { x: Math.round(point.x), y: Math.round(point.y) },
    });
    await waitFor(() => api().getActiveNodeId() === "root");

    // Shift+Down anchors at the current node and moves focus to the next one.
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
    await waitFor(() => api().getActiveNodeId() === "a");
    let sel = api().getSelection();
    expect(sel.selAnchorNodeId).toBe("root");

    // Extending further keeps the original anchor.
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
    await waitFor(() => api().getActiveNodeId() === "b");
    sel = api().getSelection();
    expect(sel.selAnchorNodeId).toBe("root");

    // Shift+Up shrinks the selection back toward the anchor.
    await userEvent.keyboard("{Shift>}{ArrowUp}{/Shift}");
    await waitFor(() => api().getActiveNodeId() === "a");
    sel = api().getSelection();
    expect(sel.selAnchorNodeId).toBe("root");

    // A plain (no-shift) arrow clears the multi-node selection.
    await userEvent.keyboard("{ArrowDown}");
    await waitFor(() => api().getSelection().selAnchorNodeId === null);
    expect(api().getSelection().selAnchorNodeId).toBeNull();
  });
});
