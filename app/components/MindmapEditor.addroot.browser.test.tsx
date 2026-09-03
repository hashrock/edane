import { describe, it, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import MindmapEditor from "./MindmapEditor";
import type { MindMapModel } from "../domain/model";
import type { MindmapTestApi } from "./MindmapEditor";

/**
 * Tree roots are created only on purpose: right-click on empty canvas offers
 * "Add root here", and nothing else (Enter on a tree root, paste, drop) makes
 * one. See `isTopLevel` in domain/model.ts.
 */

const MODEL: MindMapModel = {
  id: "root",
  text: "Root",
  children: [
    {
      id: "a",
      text: "Alpha",
      children: [{ id: "a1", text: "One", children: [] }],
    },
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
    await new Promise((r) => setTimeout(r, 20));
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

async function setup(readOnly = false) {
  render(
    <MindmapEditor
      initialContent={JSON.stringify(MODEL)}
      initialTitle="Root"
      readOnly={readOnly}
    />
  );
  await waitFor(() => api().getActiveNodeId() === "a");
  await waitFor(() => api().getRedrawStats().redrawCount > 0);
  const canvas = document.querySelector<HTMLElement>('[data-testid="mm-canvas"]')!;
  const target = canvas.querySelector("canvas") ?? canvas;
  const rightClick = (x: number, y: number) =>
    target.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: x,
        clientY: y,
      })
    );
  return { rightClick };
}

const menuButton = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
    b.textContent?.includes(label)
  );

describe("adding a tree root", () => {
  it("right-click on empty canvas → 'Add root here' creates a blank placed root in edit mode", async () => {
    const { rightClick } = await setup();
    // Top-left corner: nothing is drawn there (the tree is centred on open).
    rightClick(60, 100);
    const btn = await waitFor(() => menuButton("Add root here"));
    btn.click();

    await waitFor(() => api().getModel().children.length === 2);
    const created = api().getModel().children[1];
    expect(created.text).toBe("");
    expect(created.position).toBeDefined();
    expect(api().getActiveNodeId()).toBe(created.id);
    expect(api().getSelection().editing).toBe(true);
    // It is drawn where the click was (box left edge / vertical centre).
    const rect = await waitFor(() => api().getNodeRect(created.id));
    expect(Math.abs(rect.x - 60)).toBeLessThan(2);
    expect(Math.abs(rect.y + rect.height / 2 - 100)).toBeLessThan(2);

    // Typing lands in the new root.
    await userEvent.keyboard("Beta");
    await waitFor(() => api().getModel().children[1].text === "Beta");
  });

  it("right-click on a node opens the node menu, not the root item", async () => {
    const { rightClick } = await setup();
    const point = await waitFor(() => api().getNodeClickPoint("a1"));
    rightClick(Math.round(point.x), Math.round(point.y));
    await waitFor(() => menuButton("Add child node"));
    expect(menuButton("Add root here")).toBeUndefined();
  });

  it("offers nothing in read-only mode", async () => {
    const { rightClick } = await setup(true);
    rightClick(60, 100);
    await new Promise((r) => setTimeout(r, 200));
    expect(menuButton("Add root here")).toBeUndefined();
  });
});
