import { describe, expect, it } from "vitest";
import type { MindMapDocument } from "./domain/model";
import { DEFAULT_PAGE_THEME } from "./domain/pageTheme";
import { renderWebPage } from "./webpage-view";

const doc: MindMapDocument = {
  title: "Site </title><script>alert(1)</script>",
  theme: {
    ...DEFAULT_PAGE_THEME,
    headingFont: "zen-maru-gothic",
    background: { ...DEFAULT_PAGE_THEME.background, preset: "waves" },
    css: '.wp-heading { color: red; } .x::after { content: "</style><script>alert(2)</script>"; }',
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

  it("loads the theme's fonts and scoped CSS", () => {
    expect(html).toContain("https://fonts.googleapis.com/css2?family=Zen+Maru+Gothic");
    expect(html).toContain("@scope (.wp-root) {\n.wp-heading { color: red; }");
  });

  it("lets no script in from the title, node text, markdown, links or CSS", () => {
    const scripts = html.match(/<script[^>]*>/g) ?? [];
    // Only the runtime module and the JSON data block.
    expect(scripts).toHaveLength(2);
    expect(scripts.some((s) => s.includes('type="application/json"'))).toBe(true);
    expect(html).not.toMatch(/alert\(\d\)<\/script>/);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain('href="javascript:');
  });
});
