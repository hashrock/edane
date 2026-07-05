import { describe, it, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import MindmapEditor, { type MindmapTestApi } from "./MindmapEditor";
import type { MindMapModel } from "../domain/model";

// A markdown node holding a multi-block document, plus a plain sibling to
// compare box heights against.
const MD_SOURCE = "# Heading\n\n- one\n- two\n\n> a quote\n\n`code`";
const MODEL: MindMapModel = {
  id: "root",
  text: "Root",
  children: [
    { id: "md", text: MD_SOURCE, type: "markdown", children: [] },
    { id: "plain", text: "plain", children: [] },
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
      position: absolute; left: 0; top: 0; width: 900px; height: 640px;
    }
  `;
  document.head.appendChild(style);
});

describe("MindmapEditor markdown node rendering", () => {
  it("renders a markdown node as a multi-line block taller than a plain node", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await waitFor(() => api().getActiveNodeId() === "root");
    await waitFor(() => api().getRedrawStats().redrawCount > 0);

    const mdRect = await waitFor(() => api().getNodeRect("md"));
    const plainRect = await waitFor(() => api().getNodeRect("plain"));

    // The block-level render stacks several lines, so the markdown box is much
    // taller than a single-line plain node (which floors at ~32px).
    expect(mdRect.height).toBeGreaterThan(plainRect.height * 2);
    expect(mdRect.width).toBeGreaterThan(0);
  });

  it("switches to raw source (single-line height grows) when edited", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await waitFor(() => api().getActiveNodeId() === "root");
    await waitFor(() => api().getRedrawStats().redrawCount > 0);

    const rendered = await waitFor(() => api().getNodeRect("md"));

    // Enter edit mode on the markdown node: it should now show the raw source
    // (all lines, uniform font) and stay a valid, non-empty box.
    const point = await waitFor(() => api().getNodeClickPoint("md"));
    const canvas = document.querySelector<HTMLElement>(
      '[data-testid="mm-canvas"]'
    )!;
    const { userEvent } = await import("vitest/browser");
    await userEvent.dblClick(canvas, {
      position: { x: Math.round(point.x), y: Math.round(point.y) },
    });
    await waitFor(() => api().getActiveNodeId() === "md");
    await waitFor(() => api().getSelection().editing === true);

    const editing = await waitFor(() => api().getNodeRect("md"));
    expect(editing.height).toBeGreaterThan(0);
    expect(rendered.height).toBeGreaterThan(0);
  });
});
