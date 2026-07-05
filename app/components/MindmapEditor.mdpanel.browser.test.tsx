import { describe, it, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import MindmapEditor, { type MindmapTestApi } from "./MindmapEditor";
import type { MindMapModel } from "../domain/model";

const MD_SOURCE =
  "# 見出し\n\n- 項目A\n- 項目B\n\n> 引用\n\n<script>alert(1)</script>";
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

const panel = () => document.querySelector('[data-testid="md-panel"]');
const panelBody = () =>
  document.querySelector('[data-testid="md-panel-body"]');
const findNode = (m: MindMapModel, id: string): MindMapModel | null =>
  m.id === id ? m : m.children.reduce<MindMapModel | null>(
    (hit, c) => hit ?? findNode(c, id),
    null
  );

beforeEach(() => {
  const style = document.createElement("style");
  style.textContent = `
    [data-testid="mm-canvas"] {
      position: absolute; left: 0; top: 0; width: 900px; height: 640px;
    }
  `;
  document.head.appendChild(style);
});

describe("MindmapEditor markdown compact card + panel", () => {
  it("renders the markdown node as a compact card, not a tall block", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await waitFor(() => api().getActiveNodeId() === "root");
    await waitFor(() => api().getRedrawStats().redrawCount > 0);

    const mdRect = await waitFor(() => api().getNodeRect("md"));
    const plainRect = await waitFor(() => api().getNodeRect("plain"));
    // Compact: the card is a single row, ~same height as a plain node — nowhere
    // near the multi-line document's height.
    expect(mdRect.height).toBeLessThan(plainRect.height * 1.5);
  });

  it("opens the panel with sanitized rendered HTML on edit intent", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await waitFor(() => api().getActiveNodeId() === "root");
    await waitFor(() => api().getRedrawStats().redrawCount > 0);

    // Select the markdown node, then press Space (edit intent → panel).
    const point = await waitFor(() => api().getNodeClickPoint("md"));
    const canvas = document.querySelector<HTMLElement>(
      '[data-testid="mm-canvas"]'
    )!;
    await userEvent.click(canvas, {
      position: { x: Math.round(point.x), y: Math.round(point.y) },
    });
    await waitFor(() => api().getActiveNodeId() === "md");
    await userEvent.keyboard("[Space]");

    const body = await waitFor(panelBody);
    // Full-fidelity render: heading + list become real elements.
    expect(body.querySelector("h1")?.textContent).toBe("見出し");
    expect(body.querySelectorAll("li").length).toBe(2);
    // The canvas stays in selection mode (markdown never edits on-canvas).
    expect(api().getSelection().editing).toBe(false);
    // DOMPurify stripped the script tag.
    expect(body.querySelector("script")).toBeNull();
    expect(body.innerHTML).not.toContain("alert(1)");
  });

  it("edits the source from the panel's edit tab", async () => {
    render(
      <MindmapEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await waitFor(() => api().getActiveNodeId() === "root");
    await waitFor(() => api().getRedrawStats().redrawCount > 0);

    const point = await waitFor(() => api().getNodeClickPoint("md"));
    const canvas = document.querySelector<HTMLElement>(
      '[data-testid="mm-canvas"]'
    )!;
    await userEvent.click(canvas, {
      position: { x: Math.round(point.x), y: Math.round(point.y) },
    });
    await waitFor(() => api().getActiveNodeId() === "md");
    await userEvent.keyboard("[Space]");
    await waitFor(panel);

    // Switch to the edit tab (found by its label).
    const editBtn = await waitFor(() =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          '[data-testid="md-panel"] button'
        )
      ).find((b) => b.textContent === "編集")
    );
    editBtn.click();

    // Append text via the native value setter so React's onChange fires
    // deterministically (avoids canvas-overlay actionability flakiness).
    const textarea = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>('[data-testid="md-panel"] textarea')
    );
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )!.set!;
    setValue.call(textarea, textarea.value + "ZZZ");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => findNode(api().getModel(), "md")!.text.includes("ZZZ"));
    // Still a markdown node after editing.
    expect(findNode(api().getModel(), "md")!.type).toBe("markdown");
  });
});
