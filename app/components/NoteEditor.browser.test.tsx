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
  `;
  document.head.appendChild(style);
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
