import { describe, it, expect, afterEach } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import NoteEditor from "./NoteEditor";
import type { MindMapModel } from "../domain/model";
// The real page-view stylesheet: the frame's containment is under test.
import "./webpage.css";

/**
 * Webページモード: the header toggle shows the page the selected item is on in
 * the top-right corner, following the selection; the theme panel edits the
 * note's theme, which the preview picks up — author CSS included, confined to
 * the page.
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

async function waitFor(fn: () => boolean, timeout = 5000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 30));
  }
}

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const counter = () => q('[data-testid="webpage-preview-counter"]')?.textContent;
const previewText = () => q('[data-testid="webpage-preview-page"]')?.textContent ?? "";
const row = (text: string) =>
  Array.from(document.querySelectorAll<HTMLElement>(".cursor-text")).find((el) => el.textContent === text)!;

afterEach(() => {
  document.querySelectorAll('[data-testid="page-theme-css"]').forEach((el) => el.remove());
});

async function openWebMode() {
  await page.viewport(600, 800);
  render(<NoteEditor initialContent={JSON.stringify({ version: 2, roots: ROOTS })} initialTitle="Deck" />);
  await waitFor(() => q('[data-testid="outline-view"]') !== null);
  q<HTMLButtonElement>('[data-testid="view-webpage"]')!.click();
  await waitFor(() => q('[data-testid="webpage-preview"]') !== null);
}

describe("Web page mode (browser e2e)", () => {
  it("previews the page of the selected item and follows the selection", async () => {
    await openWebMode();
    expect(counter()).toBe("Page 1 / 3");
    expect(previewText()).toContain("Talk");

    await userEvent.click(row("How"));
    await waitFor(() => counter() === "Page 3 / 3");
    expect(previewText()).toContain("How");

    await userEvent.click(row("fast"));
    await waitFor(() => counter() === "Page 2 / 3");
    expect(previewText()).toMatch(/Why.*fast/);

    // The toggle hides it again.
    q<HTMLButtonElement>('[data-testid="view-webpage"]')!.click();
    await waitFor(() => q('[data-testid="webpage-preview"]') === null);
  });

  it("applies theme edits to the preview, with author CSS confined to the page", async () => {
    await openWebMode();
    q<HTMLButtonElement>('[data-testid="webpage-theme-open"]')!.click();
    await waitFor(() => q('[data-testid="page-theme-panel"]') !== null);

    await userEvent.selectOptions(page.getByTestId("theme-bg-preset"), "waves");
    await waitFor(() => q('[data-testid="webpage-preview-page"] > canvas.wp-bg') !== null);

    // A stray } would close the scope: the whole CSS is refused.
    await userEvent.fill(page.getByTestId("theme-css"), ".wp-heading { color: red; } } body { display: none; }");
    await new Promise((r) => setTimeout(r, 400));
    expect(q('[data-testid="page-theme-css"]')).toBeNull();
    expect(getComputedStyle(document.body).display).not.toBe("none");

    // Balanced CSS styles the page — and only the page, even when it tries to cover the screen.
    await userEvent.fill(
      page.getByTestId("theme-css"),
      ".wp-heading { color: rgb(255, 0, 0); position: fixed; inset: 0; } body, .cursor-text { display: none; }"
    );
    await waitFor(() => q('[data-testid="page-theme-css"]') !== null);
    const heading = q('[data-testid="webpage-preview-page"] .wp-heading')!;
    expect(getComputedStyle(heading).color).toBe("rgb(255, 0, 0)");
    expect(getComputedStyle(document.body).display).not.toBe("none");
    expect(getComputedStyle(row("Talk")).display).not.toBe("none");
    const frame = heading.closest(".wp-frame")!.getBoundingClientRect();
    const box = heading.getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(frame.left - 1);
    expect(box.right).toBeLessThanOrEqual(frame.right + 1);
    expect(box.bottom).toBeLessThanOrEqual(frame.bottom + 1);

    // Escape closes the panel; the theme stays.
    page.getByTestId("theme-css").element().focus();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => q('[data-testid="page-theme-panel"]') === null);
    expect(q('[data-testid="page-theme-css"]')).not.toBeNull();
  });

  it("uses the same theme in the slideshow", async () => {
    await openWebMode();
    q<HTMLButtonElement>('[data-testid="webpage-theme-open"]')!.click();
    await waitFor(() => q('[data-testid="page-theme-panel"]') !== null);
    await userEvent.fill(page.getByTestId("theme-css"), ".wp-heading { color: rgb(0, 0, 255); }");
    await waitFor(() => q('[data-testid="page-theme-css"]') !== null);
    q<HTMLButtonElement>('[data-testid="view-present"]')!.click();
    await waitFor(() => q('[data-testid="slideshow"]') !== null);
    expect(getComputedStyle(q('[data-testid="slide"] .wp-heading')!).color).toBe("rgb(0, 0, 255)");
  });
});
