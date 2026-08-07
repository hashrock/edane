/**
 * Edge auto-scroll + Escape-cancel for branch drags (see lib/dragAutoScroll and
 * the drag handlers in MindmapEditor). Both are things you can only observe by
 * actually dragging: the ramp needs real animation frames, and "cancel" is
 * defined by what the editor does NOT do on release.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
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

const CANVAS_W = 800;
const CANVAS_H = 560;

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  const style = document.createElement("style");
  style.textContent = `
    [data-testid="mm-canvas"] {
      position: absolute; left: 0; top: 0;
      width: ${CANVAS_W}px; height: ${CANVAS_H}px;
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

  /** mousedown on `id` and cross DRAG_THRESHOLD, leaving the button down. */
  const grab = async (id: string) => {
    const from = await waitFor(() => api().getNodeClickPoint(id));
    fire("mousedown", from.x, from.y);
    fire("mousemove", from.x + 10, from.y + 10);
    return from;
  };

  return { fire, grab };
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

/** Screen x of a node's box, for observing the view pan. */
const screenX = (id: string) => api().getNodeRect(id)!.x;
const screenY = (id: string) => api().getNodeRect(id)!.y;

/** Wait until `read()` has moved at least `px` away from `from`. */
async function waitForShift(read: () => number, from: number, px: number) {
  await waitFor(() => Math.abs(read() - from) >= px);
  return read();
}

describe("MindmapEditor drag edge auto-scroll", () => {
  it("pans the view while the drag is parked against an edge", async () => {
    const { fire, grab } = await setup();
    const rootX0 = screenX("root");
    await grab("b");

    // Park against the right edge: content slides left to reveal what's there.
    fire("mousemove", CANVAS_W - 40, CANVAS_H / 2);
    const rootX1 = await waitForShift(() => screenX("root"), rootX0, 60);
    expect(rootX1).toBeLessThan(rootX0);

    // Left edge reverses it.
    fire("mousemove", 40, CANVAS_H / 2);
    await waitForShift(() => screenX("root"), rootX1, 60);
    expect(screenX("root")).toBeGreaterThan(rootX1);

    fire("mouseup", 40, CANVAS_H / 2);
    // The pan stops with the drag.
    const settled = screenX("root");
    await sleep(150);
    expect(screenX("root")).toBe(settled);
  });

  it("scrolls vertically at the top/bottom edges", async () => {
    const { fire, grab } = await setup();
    const rootY0 = screenY("root");
    await grab("b");

    fire("mousemove", CANVAS_W / 2, CANVAS_H - 30);
    const rootY1 = await waitForShift(() => screenY("root"), rootY0, 60);
    expect(rootY1).toBeLessThan(rootY0);

    fire("mouseup", CANVAS_W / 2, CANVAS_H - 30);
  });

  it("does not scroll while the pointer stays away from the edges", async () => {
    const { fire, grab } = await setup();
    const rootX0 = screenX("root");
    await grab("b");

    fire("mousemove", CANVAS_W / 2, CANVAS_H / 2);
    await sleep(200);
    expect(screenX("root")).toBe(rootX0);

    fire("mouseup", CANVAS_W / 2, CANVAS_H / 2);
  });

  it("re-resolves the drop target against the scrolled view", async () => {
    // The pointer never moves while auto-scrolling, but the world under it
    // does — a drop right after a scroll must land on what is there NOW.
    const { fire, grab } = await setup();
    const rootX0 = screenX("root");
    await grab("b");

    fire("mousemove", CANVAS_W - 40, CANVAS_H / 2);
    await waitForShift(() => screenX("root"), rootX0, 60);
    fire("mousemove", CANVAS_W / 2, CANVAS_H / 2); // stop scrolling

    // "a" has moved on screen; dropping at its new box must still work.
    const rect = api().getNodeRect("a")!;
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    fire("mousemove", cx, cy);
    fire("mouseup", cx, cy);

    await waitFor(() => childIds(api().getModel(), "a").length === 2);
    expect(childIds(api().getModel(), "a")).toEqual(["a1", "b"]);
  });

  it("keeps drawing nodes that the auto-scroll brings into view", async () => {
    // Viewport culling only builds nodes near the visible rect; a long
    // auto-scroll must keep refilling it instead of leaving a blank canvas.
    const { fire, grab } = await setup();
    const before = api().getRedrawStats().redrawCount;
    const rootX0 = screenX("root");
    await grab("b");

    fire("mousemove", 4, CANVAS_H / 2); // deep in the band = fast
    await waitForShift(() => screenX("root"), rootX0, 400);
    expect(api().getRedrawStats().redrawCount).toBeGreaterThan(before);

    fire("mouseup", 4, CANVAS_H / 2);
  });
});

describe("MindmapEditor drag cancel with Escape", () => {
  it("abandons the move without touching the document", async () => {
    const { fire, grab } = await setup();
    const before = JSON.stringify(api().getModel());
    await grab("b");

    const rect = api().getNodeRect("a")!;
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    fire("mousemove", cx, cy);

    await userEvent.keyboard("{Escape}");
    fire("mouseup", cx, cy); // the release must not drop anything

    await sleep(150);
    expect(JSON.stringify(api().getModel())).toBe(before);
  });

  it("leaves the undo history untouched", async () => {
    const { fire, grab } = await setup();
    const original = JSON.stringify(api().getModel());

    // One real move, so there is exactly one entry to undo.
    await grab("b");
    const rectA = api().getNodeRect("a")!;
    fire("mousemove", rectA.x + rectA.width / 2, rectA.y + rectA.height / 2);
    fire("mouseup", rectA.x + rectA.width / 2, rectA.y + rectA.height / 2);
    await waitFor(() => childIds(api().getModel(), "a").length === 2);
    const afterMove = JSON.stringify(api().getModel());

    // Then a cancelled one.
    await grab("a1");
    const rectRoot = api().getNodeRect("root")!;
    fire(
      "mousemove",
      rectRoot.x + rectRoot.width / 2,
      rectRoot.y + rectRoot.height / 2
    );
    await userEvent.keyboard("{Escape}");
    fire(
      "mouseup",
      rectRoot.x + rectRoot.width / 2,
      rectRoot.y + rectRoot.height / 2
    );
    await sleep(150);
    expect(JSON.stringify(api().getModel())).toBe(afterMove);

    // A single undo must reach the state before the real move — it would land
    // on `afterMove` if the cancel had pushed an entry of its own.
    await userEvent.keyboard("{Meta>}z{/Meta}");
    await waitFor(() => JSON.stringify(api().getModel()) === original);
  });

  it("restores the selection the drag took over", async () => {
    const { fire, grab } = await setup();
    expect(api().getActiveNodeId()).toBe("root");

    await grab("b"); // mousedown already moved the selection onto "b"
    expect(api().getActiveNodeId()).toBe("b");

    const rect = api().getNodeRect("a")!;
    fire("mousemove", rect.x + rect.width / 2, rect.y + rect.height / 2);
    await userEvent.keyboard("{Escape}");
    fire("mouseup", rect.x + rect.width / 2, rect.y + rect.height / 2);

    await waitFor(() => api().getActiveNodeId() === "root");
    expect(api().getSelection().editing).toBe(false);
  });

  it("rewinds the view that auto-scroll moved", async () => {
    const { fire, grab } = await setup();
    const rootX0 = screenX("root");
    const rootY0 = screenY("root");
    await grab("b");

    fire("mousemove", CANVAS_W - 30, CANVAS_H - 30);
    await waitForShift(() => screenX("root"), rootX0, 80);

    await userEvent.keyboard("{Escape}");
    fire("mouseup", CANVAS_W - 30, CANVAS_H - 30);

    await waitFor(() => Math.abs(screenX("root") - rootX0) < 0.5);
    expect(screenY("root")).toBeCloseTo(rootY0, 1);
    // …and it stays put: the cancel also stopped the auto-scroll loop.
    await sleep(150);
    expect(screenX("root")).toBeCloseTo(rootX0, 1);
  });

  it("stops the drag for good — further motion neither previews nor drops", async () => {
    const { fire, grab } = await setup();
    const before = JSON.stringify(api().getModel());
    await grab("b");
    await userEvent.keyboard("{Escape}");

    const rect = api().getNodeRect("a")!;
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    fire("mousemove", cx, cy);
    fire("mouseup", cx, cy);

    await sleep(150);
    expect(JSON.stringify(api().getModel())).toBe(before);
  });

  it("still exits edit mode when no drag is in flight", async () => {
    // The cancel handler swallows Escape only during a real move drag; the
    // keymap's edit-escape must keep working everywhere else.
    const { grab } = await setup();
    const canvas = document.querySelector<HTMLElement>(
      '[data-testid="mm-canvas"]'
    )!;
    const point = await waitFor(() => api().getNodeClickPoint("a"));
    await userEvent.click(canvas, {
      position: { x: Math.round(point.x), y: Math.round(point.y) },
    });
    await waitFor(() => api().getActiveNodeId() === "a");
    await userEvent.keyboard("[Space]");
    await waitFor(() => api().getSelection().editing === true);

    await userEvent.keyboard("{Escape}");
    await waitFor(() => api().getSelection().editing === false);
    expect(api().getActiveNodeId()).toBe("a");
    void grab;
  });
});
