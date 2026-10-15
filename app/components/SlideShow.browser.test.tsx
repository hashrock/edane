import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import NoteEditor from "./NoteEditor";
import type { MindMapModel } from "../domain/model";

/**
 * プレゼンモード: ヘッダーのボタン / F5 で選択中の項目からスライドショーを開き、
 * キーはエディタに漏らさず、Esc で抜けると見ていたスライドの項目が選択される。
 */

const ROOTS: MindMapModel[] = [
  {
    id: "talk",
    text: "Talk",
    children: [
      { id: "why", text: "Why", children: [{ id: "fast", text: "fast", children: [] }] },
      { id: "how", text: "How", children: [] },
    ],
  },
];

async function waitFor(fn: () => boolean) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > 5000) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 30));
  }
}

const show = () => document.querySelector<HTMLElement>('[data-testid="slideshow"]');
const slideText = () => document.querySelector('[data-testid="slide"]')?.textContent ?? "";
const counter = () => document.querySelector('[data-testid="slide-counter"]')?.textContent;

const restores: (() => void)[] = [];
beforeEach(() => {
  const style = document.createElement("style");
  // Tailwind isn't compiled in browser tests: give the overlay the box it has in the app.
  style.textContent = `
    [data-testid="mm-canvas"] { position: absolute; left: 0; top: 0; width: 800px; height: 560px; }
    [data-testid="slideshow"] { position: fixed; inset: 0; z-index: 100; background: #000; }
    [data-testid="slide"] { width: 1000px; height: 562px; background: #fff; }
  `;
  document.head.appendChild(style);
  restores.push(() => style.remove());
});
afterEach(() => {
  while (restores.length) restores.pop()!();
});

function renderEditor() {
  render(
    <NoteEditor initialContent={JSON.stringify({ version: 2, roots: ROOTS })} initialTitle="Deck" />
  );
}

describe("SlideShow (browser e2e)", () => {
  it("starts at the selected item, keeps keys from the editor, and hands the slide back on Esc", async () => {
    await page.viewport(600, 800);
    renderEditor();
    await waitFor(() => document.querySelector('[data-testid="outline-view"]') !== null);

    const howRow = Array.from(document.querySelectorAll<HTMLElement>(".cursor-text")).find(
      (el) => el.textContent === "How"
    )!;
    await userEvent.click(howRow);
    document.querySelector<HTMLButtonElement>('[data-testid="view-present"]')!.click();
    await waitFor(() => show() !== null);
    expect(counter()).toBe("3 / 3");
    expect(slideText()).toContain("How");

    await userEvent.keyboard("x");
    await userEvent.keyboard("{ArrowLeft}");
    expect(counter()).toBe("2 / 3");
    expect(slideText()).toMatch(/Why.*fast/);

    await userEvent.keyboard("{Escape}");
    await waitFor(() => show() === null);
    // "x" never reached the editor.
    expect(document.querySelector('[data-testid="outline-view"]')!.textContent).not.toContain("x");

    // Esc selected "Why", so the next show resumes there.
    await userEvent.keyboard("{F5}");
    await waitFor(() => show() !== null);
    expect(counter()).toBe("2 / 3");
  });

  it("opens from F5 on the canvas and advances by clicking the slide", async () => {
    await page.viewport(1280, 800);
    renderEditor();
    await waitFor(() => document.querySelector('[data-testid="mm-canvas"]') !== null);

    await userEvent.keyboard("{F5}");
    await waitFor(() => show() !== null);
    expect(counter()).toBe("1 / 3");
    expect(slideText()).toContain("Talk");

    await userEvent.click(page.getByTestId("slide"), { position: { x: 600, y: 200 } });
    expect(counter()).toBe("2 / 3");
    await userEvent.click(page.getByTestId("slide"), { position: { x: 20, y: 200 } });
    expect(counter()).toBe("1 / 3");
  });
});
