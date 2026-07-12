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

// The collapse handle sits 6px past the connector's straight stub; the count
// badge sits just past the collapsed node's right edge. Both are derived from
// the same scale, recovered from two existing screen-space API points (the +6px
// stub is exactly the gap between the click point and the handle, doubled out).
function stageScale(id: string): number {
  const rect = api().getNodeRect(id)!;
  const click = api().getNodeClickPoint(id)!;
  const handle = api().getConnectorHandlePoint(id)!;
  const a = click.x - rect.x; // (NODE_PADDING + textW/2) * scale
  const b = handle.x - rect.x; // (textW + 40 + 6) * scale
  return (b - 2 * a) / 6; // (46 - 40) * scale / 6 = scale
}

describe("MindmapEditor connector collapse handle", () => {
  it("clicking the connector-junction minus button collapses the branch", async () => {
    const { click } = await setup();
    expect(findNode(api().getModel(), "a")!.collapsed).toBeFalsy();

    const handle = await waitFor(() => api().getConnectorHandlePoint("a"));
    click(handle.x, handle.y);

    await waitFor(() => !!findNode(api().getModel(), "a")!.collapsed);
    // Once collapsed there is no handle (the branch has no visible children).
    expect(api().getConnectorHandlePoint("a")).toBeNull();
  });

  it("clicking the count badge on a collapsed node expands it again", async () => {
    const { click } = await setup();
    const scale = stageScale("a");

    // Collapse "a" first.
    const handle = await waitFor(() => api().getConnectorHandlePoint("a"));
    click(handle.x, handle.y);
    await waitFor(() => !!findNode(api().getModel(), "a")!.collapsed);

    // The badge is a 9px-radius pill centred 4+9px past the box's right edge.
    const rect = await waitFor(() => api().getNodeRect("a"));
    const badgeX = rect.x + rect.width + (4 + 9) * scale;
    const badgeY = rect.y + rect.height / 2;
    click(badgeX, badgeY);

    await waitFor(() => !findNode(api().getModel(), "a")!.collapsed);
    // Expanded again → the handle is back.
    expect(api().getConnectorHandlePoint("a")).not.toBeNull();
  });

  it("a leaf node (no children) has no collapse handle", async () => {
    await setup();
    expect(api().getConnectorHandlePoint("b")).toBeNull();
  });
});
