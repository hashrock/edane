import { describe, it, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import MindmapEditor, { type MindmapTestApi } from "./MindmapEditor";
import type { MindMapModel } from "../domain/model";

// Object-card nodes: an expanded object node renders as a card whose direct
// children are its field rows. The rows stay ordinary nodes — the same
// one-dimensional keyboard editing (arrows / Enter / Escape) must work on
// them, and Enter on the card itself must create the next prefilled card.

const MODEL: MindMapModel = {
  id: "root",
  text: "Root",
  children: [
    {
      id: "card",
      text: "商品A",
      type: "object",
      children: [
        { id: "r1", text: "価格: 1200", children: [] },
        { id: "r2", text: "在庫: 5", children: [] },
      ],
    },
    { id: "t", text: "Plain", children: [] },
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

function findNode(node: MindMapModel, id: string): MindMapModel | null {
  if (node.id === id) return node;
  for (const child of node.children) {
    const hit = findNode(child, id);
    if (hit) return hit;
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

async function renderAndWait() {
  render(
    <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
  );
  await waitFor(() => api().getActiveNodeId() === "root");
  await waitFor(() => api().getRedrawStats().redrawCount > 0);
}

/**
 * Click a node (rows included) and wait until it is the active node. A card's
 * vertical centre is covered by its rows, so cards are clicked near the top
 * (their title band) via `at: "top"`.
 */
async function selectNode(nodeId: string, at: "center" | "top" = "center") {
  const canvas = document.querySelector<HTMLElement>(
    '[data-testid="mm-canvas"]'
  )!;
  for (let attempt = 0; attempt < 4; attempt++) {
    const rect = await waitFor(() => api().getNodeRect(nodeId));
    await userEvent.click(canvas, {
      position: {
        x: Math.round(rect.x + rect.width / 2),
        y: Math.round(rect.y + (at === "top" ? 14 : rect.height / 2)),
      },
    });
    const start = Date.now();
    let hit = false;
    while (Date.now() - start < 1200) {
      if (api().getActiveNodeId() === nodeId) {
        hit = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 30));
    }
    if (hit) break;
  }
  await waitFor(() => api().getActiveNodeId() === nodeId);
}

describe("MindmapEditor object-card nodes (browser e2e)", () => {
  it("lays out field rows inside the card box", async () => {
    await renderAndWait();
    const card = await waitFor(() => api().getNodeRect("card"));
    const r1 = await waitFor(() => api().getNodeRect("r1"));
    const r2 = await waitFor(() => api().getNodeRect("r2"));
    // Rows sit within the card's box, r1 above r2.
    expect(r1.y).toBeGreaterThan(card.y);
    expect(r2.y).toBeGreaterThan(r1.y);
    expect(r2.y + r2.height).toBeLessThanOrEqual(card.y + card.height + 1);
    expect(Math.round(r1.width)).toBe(Math.round(card.width));
  });

  it("clicking a row selects it and typing replaces its text", async () => {
    await renderAndWait();
    await selectNode("r1");
    expect(api().getSelection().editing).toBe(false);

    await userEvent.keyboard("色: 赤");
    await waitFor(() => findNode(api().getModel(), "r1")!.text === "色: 赤");
    expect(api().getSelection().editing).toBe(true);
  });

  it("arrow keys walk title → rows → next node in one dimension", async () => {
    await renderAndWait();
    await selectNode("card", "top");
    await userEvent.keyboard("{ArrowDown}");
    await waitFor(() => api().getActiveNodeId() === "r1");
    await userEvent.keyboard("{ArrowDown}");
    await waitFor(() => api().getActiveNodeId() === "r2");
    await userEvent.keyboard("{ArrowDown}");
    await waitFor(() => api().getActiveNodeId() === "t");
  });

  it("Enter on a row adds the next row inside the card", async () => {
    await renderAndWait();
    await selectNode("r2");
    await userEvent.keyboard("[Space]"); // edit (caret at end via selection)
    await waitFor(() => api().getSelection().editing === true);
    await userEvent.keyboard("{End}{Enter}");
    await waitFor(() => findNode(api().getModel(), "card")!.children.length === 3);
    const card = findNode(api().getModel(), "card")!;
    expect(card.children[2].text).toBe("");
    // The new row is active and rendered inside the card.
    const newId = card.children[2].id;
    expect(api().getActiveNodeId()).toBe(newId);
    await waitFor(() => api().getNodeRect(newId));
  });

  it("Enter on the card creates the next card with prefilled keys", async () => {
    await renderAndWait();
    await selectNode("card", "top");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => api().getModel().children.length === 3);
    const created = api().getModel().children[1];
    expect(created.type).toBe("object");
    expect(created.children.map((c) => c.text)).toEqual(["価格: ", "在庫: "]);
    expect(api().getActiveNodeId()).toBe(created.id);
    // Its title is immediately editable.
    expect(api().getSelection().editing).toBe(true);
  });
});
