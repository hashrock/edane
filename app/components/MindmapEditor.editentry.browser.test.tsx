import { describe, it, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import MindmapEditor, { type MindmapTestApi } from "./MindmapEditor";
import type { MindMapModel } from "../domain/model";

/**
 * Ways into edit mode that don't go through Space / F2:
 * - ⌘/Ctrl + Enter from selection mode (plain Enter inserts a sibling).
 * - Clicking the node that is *already* selected, without waiting for the
 *   double-click delay.
 * Both must leave the first click on an unselected node, the double click, and
 * the press-and-drag gestures exactly as they were.
 */

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
      // not ready yet
    }
    if (Date.now() - start > 5000) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 30));
  }
}

function canvasEl(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-testid="mm-canvas"]')!;
}

/** Konva binds its pointer handlers to the inner canvas element. */
function fire(type: string, x: number, y: number) {
  const canvas = canvasEl();
  const target = canvas.querySelector("canvas") ?? canvas;
  target.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
    })
  );
}

/**
 * Wait out Konva's double-click window (400ms) so the next press is judged a
 * fresh click — the whole point of these cases is the *single* re-click.
 */
function afterDblClickWindow() {
  return new Promise((r) => setTimeout(r, 500));
}

/** Select `id` with a plain click and settle in selection mode. */
async function selectByClick(id: string) {
  const point = await waitFor(() => api().getNodeClickPoint(id));
  await userEvent.click(canvasEl(), {
    position: { x: Math.round(point.x), y: Math.round(point.y) },
  });
  await waitFor(() => api().getActiveNodeId() === id);
  await waitFor(() => api().getSelection().editing === false);
  return point;
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

describe("⌘/Ctrl+Enter enters edit mode", () => {
  it("starts editing the selected node with its whole text selected", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await waitFor(() => api().getActiveNodeId() === "root");
    await waitFor(() => api().getRedrawStats().redrawCount > 0);

    await selectByClick("a");

    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() => api().getSelection().editing === true);

    // Same caret placement as Space: whole text selected, so typing replaces it.
    const sel = api().getSelection();
    expect(sel.activeNodeId).toBe("a");
    expect(sel.cursorPos).toBe(0);
    expect(sel.selectionEnd).toBe("Alpha".length);

    // No sibling was inserted (plain Enter's job).
    expect(api().getModel().children.length).toBe(2);
  });

  it("leaves plain Enter as insert-sibling", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await waitFor(() => api().getActiveNodeId() === "root");
    await waitFor(() => api().getRedrawStats().redrawCount > 0);

    await selectByClick("a");
    await userEvent.keyboard("{Enter}");
    // A new empty sibling after "a", focused — not "a" itself in edit mode.
    await waitFor(() => api().getModel().children.length === 3);
    const inserted = api().getModel().children[1];
    expect(inserted.text).toBe("");
    expect(api().getActiveNodeId()).toBe(inserted.id);
  });
});

describe("re-click on the selected node enters edit mode", () => {
  it("second click edits with the caret at the click point; the first only selects", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await waitFor(() => api().getActiveNodeId() === "root");
    await waitFor(() => api().getRedrawStats().redrawCount > 0);

    // First click on an unselected node: selection only (unchanged behaviour).
    const point = await selectByClick("a");
    expect(api().getSelection().editing).toBe(false);

    // Second click on the same (already selected) node: straight into editing.
    // It lands well outside the double-click window, so this is the re-click
    // path and not Konva's dblclick handler.
    await afterDblClickWindow();
    fire("mousedown", point.x, point.y);
    fire("mouseup", point.x, point.y);
    await waitFor(() => api().getSelection().editing === true);
    // Let the hidden textarea's own "select" event land: it must not push a
    // stale whole-text range back over the caret we just set.
    await new Promise((r) => setTimeout(r, 100));

    // The caret sits where the click landed (a collapsed caret inside the
    // text), not the select-all range that Space / ⌘+Enter produce.
    const sel = api().getSelection();
    expect(sel.activeNodeId).toBe("a");
    expect(sel.cursorPos).toBe(sel.selectionEnd);
    expect(sel.cursorPos).toBeGreaterThan(0);
    expect(sel.cursorPos).toBeLessThan("Alpha".length);
  });

  it("does not fire when the press turns into a drag", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await waitFor(() => api().getActiveNodeId() === "root");
    await waitFor(() => api().getRedrawStats().redrawCount > 0);

    const point = await selectByClick("a");

    // Press on the already-selected node and drag past the threshold: this is a
    // branch move, so it must not flip into edit mode on release.
    await afterDblClickWindow();
    fire("mousedown", point.x, point.y);
    fire("mousemove", point.x + 40, point.y + 10);
    fire("mouseup", point.x + 40, point.y + 10);
    await new Promise((r) => setTimeout(r, 60));
    expect(api().getSelection().editing).toBe(false);
  });

  it("keeps double-click selecting the whole text", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await waitFor(() => api().getActiveNodeId() === "root");
    await waitFor(() => api().getRedrawStats().redrawCount > 0);

    const point = await waitFor(() => api().getNodeClickPoint("a"));
    await userEvent.dblClick(canvasEl(), {
      position: { x: Math.round(point.x), y: Math.round(point.y) },
    });

    await waitFor(() => api().getSelection().editing === true);
    const sel = api().getSelection();
    expect(sel.activeNodeId).toBe("a");
    expect(sel.cursorPos).toBe(0);
    expect(sel.selectionEnd).toBe("Alpha".length);
  });
});
