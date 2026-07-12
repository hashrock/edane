import { describe, it, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import MindmapEditor, { type MindmapTestApi } from "./MindmapEditor";
import type { MindMapModel } from "../domain/model";

// DFS order: root, a, a1, b
const MODEL: MindMapModel = {
  id: "root",
  text: "Root",
  children: [
    {
      id: "a",
      text: "Alpha",
      children: [{ id: "a1", text: "One", children: [] }],
    },
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

function findNode(m: MindMapModel, id: string): MindMapModel | null {
  if (m.id === id) return m;
  for (const c of m.children) {
    const f = findNode(c, id);
    if (f) return f;
  }
  return null;
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

async function setup(model: MindMapModel = MODEL) {
  render(
    <MindmapEditor initialContent={JSON.stringify(model)} initialTitle="Root" />
  );
  await waitFor(() => api().getActiveNodeId() === "root");
  await waitFor(() => api().getRedrawStats().redrawCount > 0);

  const canvas = document.querySelector<HTMLElement>(
    '[data-testid="mm-canvas"]'
  )!;
  const target =
    canvas.querySelector("canvas") ?? (canvas as unknown as HTMLElement);
  const fire = (type: string, x: number, y: number) =>
    target.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: Math.round(x),
        clientY: Math.round(y),
      })
    );
  const click = (x: number, y: number) => {
    fire("mousedown", x, y);
    fire("mouseup", x, y);
  };
  return { click };
}

describe("MindmapEditor unified collapse/expand toggle button", () => {
  it("clicking the toggle button collapses the branch", async () => {
    const { click } = await setup();
    expect(findNode(api().getModel(), "a")!.collapsed).toBeFalsy();

    const btn = await waitFor(() => api().getToggleButtonPoint("a"));
    click(btn.x, btn.y);

    await waitFor(() => !!findNode(api().getModel(), "a")!.collapsed);
    // The button stays put once collapsed (it becomes the count pill).
    expect(api().getToggleButtonPoint("a")).not.toBeNull();
  });

  it("clicking the same button again expands the branch", async () => {
    const { click } = await setup();

    // Collapse "a" first — the button hugs the node's right edge.
    const collapseAt = await waitFor(() => api().getToggleButtonPoint("a"));
    click(collapseAt.x, collapseAt.y);
    await waitFor(() => !!findNode(api().getModel(), "a")!.collapsed);

    // Collapse and expand share one control in one place, so clicking the same
    // point toggles it back.
    const expandAt = await waitFor(() => api().getToggleButtonPoint("a"));
    click(expandAt.x, expandAt.y);

    await waitFor(() => !findNode(api().getModel(), "a")!.collapsed);
  });

  it("a leaf node (no children) has no toggle button", async () => {
    await setup();
    expect(api().getToggleButtonPoint("b")).toBeNull();
  });
});
