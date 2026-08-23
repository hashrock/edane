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

  // Regression: the panel is a `modal-panel` surface (see EDIT_SURFACE), so the
  // editor behind it sits in SELECTION mode while the user types here. It used
  // to pull focus back to its hidden textarea on every keystroke — an edit here
  // updates the node's text, which is what the focus-sync effect watches — so
  // from the second character on, keys landed on the canvas as selection
  // shortcuts: Backspace deleted the very node being edited, Enter forked a
  // sibling, arrows jumped away. Real keystrokes are the point of this test;
  // the case above drives the textarea through a synthetic input event and
  // therefore never moves focus at all.
  it("keeps the keyboard in the panel while typing (no canvas shortcuts)", async () => {
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

    const editBtn = await waitFor(() =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          '[data-testid="md-panel"] button'
        )
      ).find((b) => b.textContent === "編集")
    );
    editBtn.click();

    const textarea = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>(
        '[data-testid="md-panel"] textarea'
      )
    );
    await waitFor(() => document.activeElement === textarea);

    const before = api().getModel();
    const siblingCount = before.children.length;

    // Several real characters: one keystroke alone would not have caught the
    // old bug, since the focus theft happened on the first one's state update.
    await userEvent.keyboard("HELLO");

    // The panel still owns the keyboard...
    expect(document.activeElement).toBe(textarea);
    // ...the text went into the markdown node, not the canvas...
    const after = api().getModel();
    expect(findNode(after, "md")!.text).toContain("HELLO");
    expect(findNode(after, "md")!.type).toBe("markdown");
    // ...and no selection shortcut fired behind it.
    expect(after.children.length).toBe(siblingCount);
    expect(api().getActiveNodeId()).toBe("md");

    // Backspace is the destructive one: in selection mode it deletes the node.
    await userEvent.keyboard("[Backspace]");
    expect(document.activeElement).toBe(textarea);
    expect(findNode(api().getModel(), "md")).not.toBeNull();
    expect(api().getModel().children.length).toBe(siblingCount);

    // Enter forks a sibling in selection mode; here it must type a newline.
    await userEvent.keyboard("[Enter]");
    expect(api().getModel().children.length).toBe(siblingCount);

    // Leaving edit mode hands the keyboard back, so arrows navigate again.
    const viewBtn = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-testid="md-panel"] button'
      )
    ).find((b) => b.textContent === "表示")!;
    viewBtn.click();
    await waitFor(() => document.activeElement !== textarea);
    await userEvent.keyboard("[ArrowDown]");
    await waitFor(() => api().getActiveNodeId() === "plain");
  });
});
