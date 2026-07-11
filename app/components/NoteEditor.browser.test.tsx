import { describe, it, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent, page } from "vitest/browser";
import NoteEditor from "./NoteEditor";
import type { MindMapModel } from "../domain/model";

const MODEL: MindMapModel = {
  id: "root",
  text: "Root",
  children: [{ id: "a", text: "Alpha", children: [] }],
};

const canvas = () => document.querySelector('[data-testid="mm-canvas"]');
const outline = () => document.querySelector('[data-testid="outline-view"]');

async function waitFor(fn: () => boolean) {
  const start = Date.now();
  while (!fn()) {
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
    /* Tailwind isn't loaded here, so the absolutely-positioned test canvas
       above would cover the in-flow header controls — lift them by hand. */
    [data-testid="view-controls"] {
      position: relative; z-index: 50; background: #fff;
    }
  `;
  document.head.appendChild(style);
});

describe("NoteEditor header view controls", () => {
  it("switches Mindmap → Outline → Mindmap from the layout dropdown", async () => {
    await page.viewport(1280, 800);
    render(
      <NoteEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await waitFor(() => canvas() !== null);

    // Open the dropdown and pick Outline.
    await page.getByTestId("view-layout-trigger").click();
    await page.getByTestId("view-layout-outline").click();
    await waitFor(() => outline() !== null);
    expect(canvas()).toBeNull();

    // The outline view shows the same controls; switch back to the mind map.
    await page.getByTestId("view-layout-trigger").click();
    await page.getByTestId("view-layout-canvas").click();
    await waitFor(() => canvas() !== null);
    expect(outline()).toBeNull();
  });

  it("zooms with the +/− buttons and resets from the percentage", async () => {
    await page.viewport(1280, 800);
    render(
      <NoteEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await waitFor(() => canvas() !== null);
    const percent = () =>
      document.querySelector('[data-testid="view-zoom-percent"]')!.textContent;
    expect(percent()).toBe("100%");

    await page.getByLabelText("ズームイン").click();
    await waitFor(() => percent() === "120%");
    await page.getByLabelText("ズームアウト").click();
    await waitFor(() => percent() === "100%");

    // Reset: zoom out twice, then click the percentage to snap back to 100%.
    await page.getByLabelText("ズームアウト").click();
    await page.getByLabelText("ズームアウト").click();
    await waitFor(() => percent() !== "100%");
    await page.getByTestId("view-zoom-percent").click();
    await waitFor(() => percent() === "100%");
  });
});

describe("NoteEditor hidden outline shortcut (⌘/Ctrl+Shift+O)", () => {
  it("forces the outline layout on a wide viewport and toggles back", async () => {
    // Widen past the 767px breakpoint so the mind map is the default layout.
    await page.viewport(1280, 800);
    render(
      <NoteEditor initialContent={JSON.stringify(MODEL)} initialTitle="Root" />
    );
    await waitFor(() => canvas() !== null);
    expect(outline()).toBeNull();

    // Force the outline: canvas disappears, outline appears.
    await userEvent.keyboard("{Control>}{Shift>}o{/Shift}{/Control}");
    await waitFor(() => outline() !== null);
    expect(canvas()).toBeNull();

    // Toggle again → back to the viewport default (canvas).
    await userEvent.keyboard("{Control>}{Shift>}o{/Shift}{/Control}");
    await waitFor(() => canvas() !== null);
    expect(outline()).toBeNull();
  });
});
