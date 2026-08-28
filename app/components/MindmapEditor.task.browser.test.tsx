import { describe, it, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import MindmapEditor, {
  type MindmapTestApi,
  type NodeRender,
} from "./MindmapEditor";
import { findNode, type MindMapModel } from "../domain/model";
import { NODE_PADDING } from "../lib/measureText";
import {
  CHECKBOX_SIZE,
  CHECKBOX_GAP,
  nodeTextOffsetX,
} from "../application/nodeUtils";

// The task checkbox as it is actually painted on the canvas, and the two ways
// to flip it (the box itself, ⌘/Ctrl+Shift+D).

// The tasks hang off one top-level node so they are ordinary (non-root-styled)
// nodes centred on its row — top-level nodes stack downward as separate trees
// and the first one starts selected, which would put the targets below the
// test viewport and turn the first click into the edit-entering re-click.
const MODEL: MindMapModel = {
  id: "root",
  text: "Shopping",
  children: [
    {
      id: "list",
      text: "groceries",
      children: [
        { id: "open", text: "buy milk", checked: false, children: [] },
        { id: "done", text: "buy bread", checked: true, children: [] },
        { id: "plain", text: "just a note", children: [] },
      ],
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
      // not ready yet
    }
    if (Date.now() - start > 5000) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 30));
  }
}

async function rendered(id: string): Promise<NodeRender> {
  return await waitFor(() => {
    const v = api().getNodeRender(id);
    return v && v.texts.length > 0 ? v : null;
  });
}

/** The checkbox is the one small square inside the node's own background rect. */
function checkbox(r: NodeRender) {
  const boxes = r.rects.filter((rect) => rect.width === CHECKBOX_SIZE);
  expect(boxes).toHaveLength(1);
  return boxes[0];
}

function canvas(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-testid="mm-canvas"]')!;
}

async function selectNode(id: string) {
  const p = await waitFor(() => api().getNodeClickPoint(id));
  await userEvent.click(canvas(), {
    position: { x: Math.round(p.x), y: Math.round(p.y) },
  });
  await waitFor(() => api().getActiveNodeId() === id);
}

/** Click a node's checkbox, aiming afresh (a toggle can pan the view). */
async function clickCheckbox(id: string) {
  const p = await waitFor(() => api().getCheckboxPoint(id));
  await userEvent.click(canvas(), {
    position: { x: Math.round(p.x), y: Math.round(p.y) },
  });
}

function checkedOf(id: string): boolean | undefined {
  return findNode(api().getModel(), id)?.checked;
}

beforeEach(() => {
  const style = document.createElement("style");
  style.textContent = `
    [data-testid="mm-canvas"] {
      position: absolute; left: 0; top: 0; width: 900px; height: 600px;
    }
  `;
  document.head.appendChild(style);
  render(
    <MindmapEditor
      initialContent={JSON.stringify(MODEL)}
      initialTitle="Shopping"
    />
  );
});

describe("task checkbox (browser e2e)", () => {
  it("draws a box in its own column, with the text after it", async () => {
    const r = await rendered("open");
    const cb = checkbox(r);
    expect(cb.width).toBe(CHECKBOX_SIZE);
    expect(cb.x).toBeCloseTo(r.box.x + NODE_PADDING, 1);
    const text = r.texts[0];
    expect(text.text).toBe("buy milk");
    expect(text.x).toBeCloseTo(cb.x + CHECKBOX_SIZE + CHECKBOX_GAP, 1);
    // The one offset every text-positioning path shares.
    expect(text.x - r.box.x).toBeCloseTo(
      nodeTextOffsetX({ checked: false }),
      1
    );
    // …and the text still ends inside the box, checkbox column and all.
    expect(text.x + text.width).toBeLessThanOrEqual(
      r.box.x + r.box.width - NODE_PADDING + 0.5
    );
  });

  it("paints a done task filled and struck through", async () => {
    const done = await rendered("done");
    expect(checkbox(done).fill).toBe("#10b981");
    expect(done.texts[0].textDecoration).toContain("line-through");

    const open = await rendered("open");
    expect(checkbox(open).fill).toBe("#ffffff");
    expect(open.texts[0].textDecoration).not.toContain("line-through");
  });

  it("draws no box at all on a node that isn't a task", async () => {
    const r = await rendered("plain");
    expect(r.rects.filter((rect) => rect.width === CHECKBOX_SIZE)).toHaveLength(0);
    expect(r.texts[0].x).toBeCloseTo(r.box.x + NODE_PADDING, 1);
  });

  it("widens the node by exactly the checkbox column", async () => {
    const task = await rendered("open");
    const plain = await rendered("plain");
    // Same font, different text, so compare the text→box slack instead: the
    // task's box carries one extra column of chrome.
    const slack = (r: NodeRender) => r.box.width - r.texts[0].width;
    expect(slack(task) - slack(plain)).toBeCloseTo(
      CHECKBOX_SIZE + CHECKBOX_GAP,
      1
    );
  });

  it("toggles when the box itself is clicked, without editing the node", async () => {
    await rendered("open");
    await clickCheckbox("open");
    await waitFor(() => checkedOf("open") === true);
    // A click on the box is a toggle, never a select-or-edit.
    expect(api().getSelection().editing).toBe(false);

    await clickCheckbox("open");
    await waitFor(() => checkedOf("open") === false);

    // …and a done task's box reopens it.
    await clickCheckbox("done");
    await waitFor(() => checkedOf("done") === false);
  });

  it("leaves the selection where it was when a box is clicked", async () => {
    // The toggle rebuilds the layer under the pointer, so the click that
    // follows the press can land on the bare stage — which reads as "clicked
    // empty space" and would otherwise drop the selection elsewhere.
    await selectNode("plain");
    await clickCheckbox("open");
    await waitFor(() => checkedOf("open") === true);
    expect(api().getActiveNodeId()).toBe("plain");
  });

  it("adds a checkbox to a plain node, then completes it, with the keyboard", async () => {
    await selectNode("plain");

    await userEvent.keyboard("{Meta>}{Shift>}d{/Shift}{/Meta}");
    await waitFor(() => checkedOf("plain") === false);
    await userEvent.keyboard("{Meta>}{Shift>}d{/Shift}{/Meta}");
    await waitFor(() => checkedOf("plain") === true);
    // Repeating never removes the checkbox — it only flips done/open.
    await userEvent.keyboard("{Meta>}{Shift>}d{/Shift}{/Meta}");
    await waitFor(() => checkedOf("plain") === false);
    expect(checkedOf("plain")).toBe(false);
  });
});
