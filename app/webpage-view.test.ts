import { describe, expect, it } from "vitest";
import type { MindMapDocument } from "./domain/model";
import { DEFAULT_PAGE_THEME, normalizePageTheme } from "./domain/pageTheme";
import { renderWebPage } from "./webpage-view";

const doc: MindMapDocument = {
  title: "Site </title><script>alert(1)</script>",
  theme: {
    ...DEFAULT_PAGE_THEME,
    headingFont: "zen-maru-gothic",
    background: { ...DEFAULT_PAGE_THEME.background, preset: "waves" },
    headingStyle: "bar",
  },
  roots: [
    {
      id: "r",
      text: "Root",
      children: [
        { id: "a", text: "<img src=x onerror=alert(3)>", children: [{ id: "a1", text: "A1", children: [] }] },
        { id: "m", text: "# md\n<script>alert(4)</script>", type: "markdown", children: [] },
        { id: "l", text: "javascript:alert(5)", type: "link", children: [] },
      ],
    },
  ],
};

describe("renderWebPage", () => {
  const html = renderWebPage(doc);

  it("renders every page of the document, stacked", () => {
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('data-variant="web"');
    expect(html.match(/<section class="wp-page/g)).toHaveLength(4);
    expect(html).toContain('<canvas class="wp-bg"');
  });

  it("loads the theme's fonts and picks its heading style", () => {
    expect(html).toContain("https://fonts.googleapis.com/css2?family=Zen+Maru+Gothic");
    expect(html).toContain('data-heading="bar"');
  });

  it("draws no author CSS, even from a theme stored with one", () => {
    const old = normalizePageTheme({ ...doc.theme, css: "body { display: none; }" })!;
    const page = renderWebPage({ ...doc, theme: old });
    expect(page).not.toContain("<style");
    expect(page).not.toContain("display: none");
  });

  it("lets no script in from the title, node text, markdown or links", () => {
    const scripts = html.match(/<script[^>]*>/g) ?? [];
    // Only the runtime module and the JSON data block.
    expect(scripts).toHaveLength(2);
    expect(scripts.some((s) => s.includes('type="application/json"'))).toBe(true);
    expect(html).not.toMatch(/alert\(\d\)<\/script>/);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain('href="javascript:');
  });
});
