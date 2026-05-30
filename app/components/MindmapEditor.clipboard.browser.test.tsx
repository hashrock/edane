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

function hiddenInput(): HTMLTextAreaElement {
  return document.querySelector<HTMLTextAreaElement>(
    'textarea[style*="caret-color"]'
  )!;
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

describe("MindmapEditor clipboard", () => {
  it("pastes multiline text as a node subtree", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await waitFor(() => api().getNodeClickPoint("root"));
    await waitFor(() => api().getRedrawStats().redrawCount > 0);

    const input = hiddenInput();
    input.focus();
    const dt = new DataTransfer();
    dt.setData("text/plain", "X\n  Y\nZ");
    input.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      })
    );

    await waitFor(() =>
      api()
        .getModel()
        .children.some((c) => c.text === "X")
    );
    const root = api().getModel();
    const x = root.children.find((c) => c.text === "X")!;
    expect(x.children[0]?.text).toBe("Y"); // indentation → child
    expect(root.children.some((c) => c.text === "Z")).toBe(true);
  });

  it("copies a multi-node selection as indented text", async () => {
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

    // Select root → a.
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
    await waitFor(() => api().getSelection().selAnchorNodeId === "root");

    const dt = new DataTransfer();
    const ev = new ClipboardEvent("copy", {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    hiddenInput().dispatchEvent(ev);

    expect(ev.defaultPrevented).toBe(true);
    expect(dt.getData("text/plain")).toBe("Root\n  Alpha");
  });
});
