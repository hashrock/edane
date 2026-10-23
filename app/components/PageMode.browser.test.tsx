import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import NoteEditor from "./NoteEditor";
import type { MindMapModel } from "../domain/model";
// The real page-view stylesheet: the heading styles are under test.
import "./webpage.css";

/**
 * ページモード: the header toggle shows the page the selected item is on in
 * the top-right corner, following the selection, as a slide or as the web
 * page; the theme panel edits the note's theme, which the preview (in either
 * format) and the slideshow pick up.
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
const counter = () => q('[data-testid="page-preview-counter"]')?.textContent;
const previewText = () => q('[data-testid="page-preview-page"]')?.textContent ?? "";
const row = (text: string) =>
  Array.from(document.querySelectorAll<HTMLElement>(".cursor-text")).find((el) => el.textContent === text)!;

async function openPageMode(roots: MindMapModel[] = ROOTS) {
  await page.viewport(600, 800);
  render(<NoteEditor initialContent={JSON.stringify({ version: 2, roots })} initialTitle="Deck" />);
  await waitFor(() => q('[data-testid="outline-view"]') !== null);
  q<HTMLButtonElement>('[data-testid="view-pages"]')!.click();
  await waitFor(() => q('[data-testid="page-preview"]') !== null);
}

describe("Pages mode (browser e2e)", () => {
  it("previews the page of the selected item and follows the selection", async () => {
    await openPageMode();
    expect(counter()).toBe("Page 1 / 3");
    expect(previewText()).toContain("Talk");

    await userEvent.click(row("How"));
    await waitFor(() => counter() === "Page 3 / 3");
    expect(previewText()).toContain("How");

    await userEvent.click(row("fast"));
    await waitFor(() => counter() === "Page 2 / 3");
    expect(previewText()).toMatch(/Why.*fast/);

    // The same page, drawn as a slide or as a screen of the web page.
    const variant = () => q('[data-testid="page-preview-page"]')?.getAttribute("data-variant");
    expect(variant()).toBe("slide");
    q<HTMLButtonElement>('[data-testid="page-format-web"]')!.click();
    await waitFor(() => variant() === "web");
    expect(counter()).toBe("Page 2 / 3");
    expect(previewText()).toMatch(/Why.*fast/);
    // Each format offers its own action: ▶ for the slides, publishing for the
    // web page (absent here — a guest note has nothing to publish).
    expect(q('[data-testid="page-present"]')).toBeNull();
    expect(q('[data-testid="page-publish-open"]')).toBeNull();
    q<HTMLButtonElement>('[data-testid="page-format-slide"]')!.click();
    await waitFor(() => q('[data-testid="page-present"]') !== null);

    // The toggle hides it again.
    q<HTMLButtonElement>('[data-testid="view-pages"]')!.click();
    await waitFor(() => q('[data-testid="page-preview"]') === null);
  });

  it("shows how many pages the selected branch takes and can give each child its own", async () => {
    const leaf = (id: string) => ({ id, text: id, children: [] });
    await openPageMode([
      { id: "talk", text: "Talk", children: [{ id: "why", text: "Why", children: [leaf("fast"), leaf("simple")] }, leaf("How")] },
    ]);
    await userEvent.click(row("Why"));
    await waitFor(() => counter() === "Page 2 / 3");
    const count = () => q('[data-testid="page-branch-count"]')?.textContent;
    expect(count()).toBe("Pages in this branch: 1");
    q<HTMLButtonElement>('[data-testid="page-split-each"]')!.click();
    await waitFor(() => counter() === "Page 2 / 5");
    expect(count()).toBe("Pages in this branch: 3");
    expect(q('[data-testid="page-split-each"]')!.getAttribute("aria-checked")).toBe("true");
    q<HTMLButtonElement>('[data-testid="page-split-auto"]')!.click();
    await waitFor(() => counter() === "Page 2 / 3");
    // A leaf has no children to split.
    await userEvent.click(row("How"));
    await waitFor(() => counter() === "Page 3 / 3");
    expect(q('[data-testid="page-split"]')).toBeNull();
  });

  it("resizes from its left / bottom edges, keeping 16:9", async () => {
    localStorage.removeItem("edane:page-preview-scale");
    await openPageMode();
    const frame = () => q('[role="img"]')!.getBoundingClientRect();
    expect(frame().width).toBe(320);
    expect(frame().height).toBe(180);

    const drag = (edge: string, dx: number, dy: number) => {
      const el = q(`[data-testid="page-preview-resize-${edge}"]`)!;
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const opts = { bubbles: true, pointerId: 1, button: 0, isPrimary: true };
      el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, clientX: x, clientY: y }));
      el.dispatchEvent(new PointerEvent("pointermove", { ...opts, clientX: x + dx, clientY: y + dy }));
      el.dispatchEvent(new PointerEvent("pointerup", { ...opts, clientX: x + dx, clientY: y + dy }));
    };

    // Dragging the left edge left widens it; the height follows.
    drag("left", -64, 0);
    await waitFor(() => frame().width === 384);
    expect(frame().height).toBe(216);
    // Dragging the bottom edge up shrinks it; the width follows.
    drag("bottom", 0, -36);
    await waitFor(() => frame().height === 180);
    expect(frame().width).toBe(320);
    // Never smaller than the minimum.
    drag("corner", 1000, -1000);
    await waitFor(() => frame().width === 192);
    expect(frame().height).toBe(108);
    // The size is remembered on this device.
    expect(localStorage.getItem("edane:page-preview-scale")).toBe("0.15");
    localStorage.removeItem("edane:page-preview-scale");
  });

  it("applies theme edits to the preview", async () => {
    await openPageMode();
    q<HTMLButtonElement>('[data-testid="page-theme-open"]')!.click();
    await waitFor(() => q('[data-testid="page-theme-panel"][data-open]') !== null);

    await userEvent.selectOptions(page.getByTestId("theme-bg-preset"), "waves");
    await waitFor(() => q('[data-testid="page-preview-page"] > canvas.wp-bg') !== null);
    q<HTMLButtonElement>('[data-testid="page-format-web"]')!.click();
    await waitFor(() => q('[data-testid="page-preview-page"][data-variant="web"] > canvas.wp-bg') !== null);

    // The heading style is picked from the swatches; the preview follows.
    const root = () => q('[data-testid="page-preview-page"]')!;
    expect(root().getAttribute("data-heading")).toBe("simple");
    await userEvent.click(page.getByTestId("theme-heading-bar"));
    await waitFor(() => root().getAttribute("data-heading") === "bar");
    expect(page.getByTestId("theme-heading-bar").element().getAttribute("aria-checked")).toBe("true");
    await userEvent.click(row("How"));
    await waitFor(() => counter() === "Page 3 / 3");
    expect(parseFloat(getComputedStyle(root().querySelector(".wp-heading")!).borderLeftWidth)).toBeGreaterThan(0);

    // So is the title page's: filled with the accent.
    await userEvent.click(page.getByTestId("theme-title-fill"));
    await waitFor(() => root().getAttribute("data-title") === "fill");
    await userEvent.click(row("Talk"));
    await waitFor(() => counter() === "Page 1 / 3");
    expect(getComputedStyle(root().querySelector(".wp-page-title")!).backgroundColor).toBe("rgb(16, 185, 129)");

    // Escape closes the panel; the theme stays.
    page.getByTestId("theme-heading-bar").element().focus();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => q('[data-testid="page-theme-panel"][data-open]') === null);
    expect(root().getAttribute("data-heading")).toBe("bar");
  });

  it("uses the same theme in the slideshow", async () => {
    await openPageMode();
    q<HTMLButtonElement>('[data-testid="page-theme-open"]')!.click();
    await waitFor(() => q('[data-testid="page-theme-panel"][data-open]') !== null);
    await userEvent.click(page.getByTestId("theme-heading-accent"));
    await waitFor(() => q('[data-testid="page-preview-page"][data-heading="accent"]') !== null);
    q<HTMLButtonElement>('[data-testid="page-present"]')!.click();
    await waitFor(() => q('[data-testid="slideshow"]') !== null);
    // The accent colour (the default theme's #10b981).
    expect(getComputedStyle(q('[data-testid="slide"] .wp-heading')!).color).toBe("rgb(16, 185, 129)");
  });
});
