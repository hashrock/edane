import { describe, it, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import MindmapEditor, { type MindmapTestApi } from "./MindmapEditor";
import type { MindMapModel } from "../domain/model";

// Root is the title (not a canvas node). DFS order: a, a1, b
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

beforeEach(() => {
  const style = document.createElement("style");
  style.textContent = `
    [data-testid="mm-canvas"] {
      position: absolute; left: 0; top: 0; width: 800px; height: 560px;
    }
  `;
  document.head.appendChild(style);
});

/** Render the editor and wait until the canvas is interactive. */
async function setup(model: MindMapModel = MODEL) {
  render(
    <MindmapEditor initialContent={JSON.stringify(model)} initialTitle="Root" />
  );
  // The first top-level node starts selected.
  await waitFor(() => api().getActiveNodeId() === "a");
  await waitFor(() => api().getRedrawStats().redrawCount > 0);

  // Konva binds its pointer handlers to the inner canvas; dispatch native
  // mouse events there so the stage's mousedown/mousemove/mouseup fire.
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

  /** mousedown on `fromId`'s text → drag to (toX, toY) → release. */
  const drag = async (fromId: string, toX: number, toY: number) => {
    const from = await waitFor(() => api().getNodeClickPoint(fromId));
    fire("mousedown", from.x, from.y);
    // Two moves: the first crosses DRAG_THRESHOLD, the second lands on target
    // (also exercises the marker-identity update path).
    fire("mousemove", from.x + 10, from.y + 10);
    fire("mousemove", toX, toY);
    fire("mouseup", toX, toY);
  };

  return { fire, drag };
}

function childIds(model: MindMapModel, id: string): string[] {
  const find = (n: MindMapModel): MindMapModel | null => {
    if (n.id === id) return n;
    for (const c of n.children) {
      const f = find(c);
      if (f) return f;
    }
    return null;
  };
  return (find(model)?.children ?? []).map((c) => c.id);
}

describe("MindmapEditor drag & drop node move", () => {
  it("dropping on a node's body makes the branch its last child", async () => {
    const { drag } = await setup();
    const rect = await waitFor(() => api().getNodeRect("a"));
    await drag("b", rect.x + rect.width / 2, rect.y + rect.height / 2);

    await waitFor(() => childIds(api().getModel(), "a").length === 2);
    expect(childIds(api().getModel(), "a")).toEqual(["a1", "b"]);
    expect(childIds(api().getModel(), "root")).toEqual(["a"]);
    // Selection follows the moved node, still in selection mode.
    expect(api().getActiveNodeId()).toBe("b");
    expect(api().getSelection().editing).toBe(false);
  });

  it("dropping on a nested node's top edge inserts as the sibling before it", async () => {
    const { drag } = await setup();
    const rect = await waitFor(() => api().getNodeRect("a1"));
    await drag("b", rect.x + rect.width / 2, rect.y + 2);

    await waitFor(() => childIds(api().getModel(), "a")[0] === "b");
    expect(childIds(api().getModel(), "a")).toEqual(["b", "a1"]);
    expect(childIds(api().getModel(), "root")).toEqual(["a"]);
  });

  it("a tree root has no sibling zone: its top edge still nests (no accidental new tree)", async () => {
    const { drag } = await setup();
    const rect = await waitFor(() => api().getNodeRect("a"));
    await drag("b", rect.x + rect.width / 2, rect.y + 2);

    await waitFor(() => childIds(api().getModel(), "a").length === 2);
    expect(childIds(api().getModel(), "a")).toEqual(["a1", "b"]);
    expect(childIds(api().getModel(), "root")).toEqual(["a"]);
  });

  it("moves the whole subtree with the node", async () => {
    const { drag } = await setup();
    const rect = await waitFor(() => api().getNodeRect("b"));
    await drag("a", rect.x + rect.width / 2, rect.y + rect.height / 2);

    await waitFor(() => childIds(api().getModel(), "b").length === 1);
    expect(childIds(api().getModel(), "b")).toEqual(["a"]);
    expect(childIds(api().getModel(), "a")).toEqual(["a1"]); // subtree intact
  });

  it("dropping a node onto its own descendant is a no-op", async () => {
    const { drag } = await setup();
    const before = JSON.stringify(api().getModel());
    const rect = await waitFor(() => api().getNodeRect("a1"));
    await drag("a", rect.x + rect.width / 2, rect.y + rect.height / 2);

    // Give any (wrong) dispatch a beat to land, then compare.
    await new Promise((r) => setTimeout(r, 100));
    expect(JSON.stringify(api().getModel())).toBe(before);
  });

  it("dropping over empty space places the tree there (free position)", async () => {
    const { drag } = await setup();
    const before = await waitFor(() => api().getNodeRect("b"));
    await drag("b", 700, 500);

    // Still a top-level tree, now pinned to a position of its own.
    await waitFor(() => api().getModel().children[1]?.position != null);
    expect(childIds(api().getModel(), "root")).toEqual(["a", "b"]);
    const after = await waitFor(() => {
      const r = api().getNodeRect("b");
      return r && r.x !== before.x ? r : null;
    });
    expect(after.x).toBeGreaterThan(before.x);
  });

  it("dropping a nested node over empty space is a no-drop (trees are made on purpose)", async () => {
    const { drag } = await setup();
    const before = JSON.stringify(api().getModel());
    await drag("a1", 700, 500);

    await new Promise((r) => setTimeout(r, 100));
    expect(JSON.stringify(api().getModel())).toBe(before);
  });

  it("a drop can be undone with Cmd+Z", async () => {
    const { drag } = await setup();
    const before = JSON.stringify(api().getModel());
    const rect = await waitFor(() => api().getNodeRect("a"));
    await drag("b", rect.x + rect.width / 2, rect.y + rect.height / 2);
    await waitFor(() => childIds(api().getModel(), "a").length === 2);

    await userEvent.keyboard("{Meta>}z{/Meta}");
    await waitFor(() => JSON.stringify(api().getModel()) === before);
    expect(childIds(api().getModel(), "root")).toEqual(["a", "b"]);
  });

  it("dragging inside the node being edited still extends a text selection", async () => {
    const { fire } = await setup();
    const point = await waitFor(() => api().getNodeClickPoint("a"));
    const canvas = document.querySelector<HTMLElement>(
      '[data-testid="mm-canvas"]'
    )!;

    // Enter edit mode on "a": it starts selected, so a click on it is the
    // "second click" that drops the caret in.
    await userEvent.click(canvas, {
      position: { x: Math.round(point.x), y: Math.round(point.y) },
    });
    await waitFor(() => api().getActiveNodeId() === "a");
    if (!api().getSelection().editing) await userEvent.keyboard("[Space]");
    await waitFor(() => api().getSelection().editing === true);

    // Drag within the edited node: a text drag-select, not a node move.
    fire("mousedown", point.x - 20, point.y);
    fire("mousemove", point.x + 20, point.y);
    fire("mouseup", point.x + 20, point.y);

    await waitFor(() => {
      const s = api().getSelection();
      return s.editing === true && s.cursorPos !== s.selectionEnd;
    });
    expect(api().getActiveNodeId()).toBe("a");
    expect(childIds(api().getModel(), "root")).toEqual(["a", "b"]); // unchanged
  });
});
