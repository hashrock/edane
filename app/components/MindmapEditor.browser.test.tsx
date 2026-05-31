import { describe, it, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import MindmapEditor, { type MindmapTestApi } from "./MindmapEditor";
import type { MindMapModel } from "../domain/model";

// Fixed-id tree so the test can target a known node.
const MODEL: MindMapModel = {
  id: "root",
  text: "Root",
  children: [
    { id: "hello", text: "Hello", children: [] },
    { id: "world", text: "World", children: [] },
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

// Tailwind isn't loaded in the component test, so force the canvas to a real
// size (otherwise Konva renders into a 0x0 stage and clicks hit nothing).
beforeEach(() => {
  const style = document.createElement("style");
  style.textContent = `
    [data-testid="mm-canvas"] {
      position: absolute; left: 0; top: 0; width: 800px; height: 560px;
    }
  `;
  document.head.appendChild(style);
});

describe("MindmapEditor (browser e2e)", () => {
  it("clicking a node focuses the hidden input and accepts typing", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );

    // Wait until Konva has laid out and the test API can locate the node.
    const point = await waitFor(() => api().getNodeClickPoint("hello"));

    const canvas = document.querySelector<HTMLElement>('[data-testid="mm-canvas"]');
    expect(canvas).toBeTruthy();

    // A real (trusted) click at the middle of the node's text → collapsed caret.
    await userEvent.click(canvas!, {
      position: { x: Math.round(point.x), y: Math.round(point.y) },
    });

    // The node becomes active and — the regression we guard against — the hidden
    // input must keep focus even though the click landed on the canvas (which is
    // not focusable and would otherwise blur the input on the trailing click).
    await waitFor(() => api().getActiveNodeId() === "hello");
    await waitFor(
      () =>
        (document.activeElement as HTMLElement | null)?.tagName === "TEXTAREA"
    );

    // A single click selects the node with its whole text selected, so typing a
    // printable character replaces it (select-then-type rename) and flips into
    // edit mode. The point of this test is that typing reaches the focused input.
    await userEvent.keyboard("X");
    const text = await waitFor(() => {
      const t = api().getModel().children[0].text;
      return t !== "Hello" ? t : null;
    });

    expect(text).toBe("X");
  });
});
