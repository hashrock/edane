import { describe, it, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import MindmapEditor, { type MindmapTestApi } from "./MindmapEditor";
import type { MindMapModel } from "../domain/model";

// Canvas counterpart of the outline view's "custom nodes keep their preview
// while editing, with a URL box below" behaviour: editing an image/link node
// must show the visible URL input instead of swapping to raw-text editing.

const MODEL: MindMapModel = {
  id: "root",
  text: "Root",
  children: [
    {
      id: "l",
      text: "https://example.com/",
      type: "link",
      linkTitle: "Example",
      children: [],
    },
    { id: "i", text: "https://example.com/x.png", type: "image", children: [] },
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

const urlInput = () =>
  document.querySelector<HTMLInputElement>('[data-testid="mm-url-input"]');

/** Render, wait until interactive, then select `nodeId` and press Space. */
async function editNode(nodeId: string) {
  render(
    <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
  );
  await waitFor(() => api().getActiveNodeId() === "root");
  await waitFor(() => api().getRedrawStats().redrawCount > 0);
  // Click near the box's left edge via getNodeRect: for custom nodes the
  // text-based click point (raw URL width) can fall outside the drawn preview
  // box, and wide boxes can extend past the small test viewport. Retry a few
  // times — an image node settling from "loading" to its final size shifts the
  // layout under the first click.
  const canvas = document.querySelector<HTMLElement>(
    '[data-testid="mm-canvas"]'
  )!;
  for (let attempt = 0; attempt < 4; attempt++) {
    const rect = await waitFor(() => api().getNodeRect(nodeId));
    await userEvent.click(canvas, {
      position: {
        x: Math.round(rect.x + 12),
        y: Math.round(rect.y + rect.height / 2),
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
  await userEvent.keyboard("[Space]");
  await waitFor(() => api().getSelection().editing === true);
}

describe("MindmapEditor URL box editing for custom nodes (browser e2e)", () => {
  it("editing a link node shows the URL box with the raw URL", async () => {
    await editNode("l");

    const input = await waitFor(urlInput);
    expect(input.value).toBe("https://example.com/");
    expect(input.placeholder).toBe("リンクのURL");
    // The box owns the keyboard while open.
    await waitFor(() => document.activeElement === urlInput());
  });

  it("typing in the URL box updates the node's URL and keeps its kind", async () => {
    await editNode("l");
    const input = await waitFor(urlInput);

    await userEvent.fill(input, "https://changed.example/");

    await waitFor(
      () => findNode(api().getModel(), "l")!.text === "https://changed.example/"
    );
    const node = findNode(api().getModel(), "l")!;
    expect(node.type).toBe("link");
    // Still editing: the box stays open for further tweaks.
    expect(api().getSelection().editing).toBe(true);
  });

  it("Enter closes the box and hands the keyboard back to node navigation", async () => {
    await editNode("l");
    await waitFor(urlInput);

    await userEvent.keyboard("{Enter}");
    await waitFor(() => api().getSelection().editing === false);
    expect(urlInput()).toBeNull();

    // Keyboard is alive again: arrows move the (single) selection.
    await userEvent.keyboard("{ArrowDown}");
    await waitFor(() => api().getActiveNodeId() === "i");
  });

  it("editing an image node shows the URL box with the image placeholder", async () => {
    await editNode("i");

    const input = await waitFor(urlInput);
    expect(input.value).toBe("https://example.com/x.png");
    expect(input.placeholder).toBe("画像のURL");

    await userEvent.fill(input, "https://example.com/y.png");
    await waitFor(
      () => findNode(api().getModel(), "i")!.text === "https://example.com/y.png"
    );
    expect(findNode(api().getModel(), "i")!.type).toBe("image");
  });

  it("editing a plain text node never shows the URL box", async () => {
    await editNode("t");
    // Editing is active but the URL box stays absent (raw-text canvas editing).
    expect(api().getSelection().editing).toBe(true);
    expect(urlInput()).toBeNull();
  });
});
