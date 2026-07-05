import { describe, it, expect } from "vitest";
import { parseMarkdownLines, layoutMarkdown } from "./markdownLayout";

describe("parseMarkdownLines", () => {
  it("sizes and bolds headings by level", () => {
    const [h1, h2, h3] = parseMarkdownLines("# A\n## B\n### C", 14);
    expect(h1).toMatchObject({ text: "A", bold: true });
    expect(h2).toMatchObject({ text: "B", bold: true });
    expect(h3).toMatchObject({ text: "C", bold: true });
    // Strictly decreasing font size down the heading levels.
    expect(h1.fontSize).toBeGreaterThan(h2.fontSize);
    expect(h2.fontSize).toBeGreaterThan(h3.fontSize);
  });

  it("gives unordered items a bullet and indents by nesting", () => {
    const lines = parseMarkdownLines("- one\n  - two", 14);
    expect(lines[0]).toMatchObject({ text: "one", bullet: "•", indent: 16 });
    // Two leading spaces = one level deeper.
    expect(lines[1].indent).toBeGreaterThan(lines[0].indent);
  });

  it("keeps the number as the marker for ordered items", () => {
    const [a, b] = parseMarkdownLines("1. first\n2. second", 14);
    expect(a).toMatchObject({ text: "first", bullet: "1." });
    expect(b).toMatchObject({ text: "second", bullet: "2." });
  });

  it("marks blockquotes italic with a gutter", () => {
    const [q] = parseMarkdownLines("> quoted", 14);
    expect(q).toMatchObject({ text: "quoted", italic: true, gutter: true });
  });

  it("renders fenced code as monospace and drops the fences", () => {
    const lines = parseMarkdownLines("```js\nconst a = 1;\n```", 14);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      text: "const a = 1;",
      mono: true,
      codeBg: true,
    });
  });

  it("does not parse Markdown inside a code fence", () => {
    const lines = parseMarkdownLines("```\n# not a heading\n- not a list\n```", 14);
    expect(lines.map((l) => l.text)).toEqual(["# not a heading", "- not a list"]);
    expect(lines.every((l) => l.mono)).toBe(true);
  });

  it("turns a horizontal rule into a rule line with no text", () => {
    const [r] = parseMarkdownLines("---", 14);
    expect(r).toMatchObject({ rule: true, text: "" });
  });

  it("strips inline emphasis to plain text", () => {
    const [p] = parseMarkdownLines("**bold** and [link](https://x.dev) and `code`", 14);
    expect(p.text).toBe("bold and link and code");
  });

  it("caps the number of rendered lines", () => {
    const src = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const lines = parseMarkdownLines(src, 14);
    expect(lines.length).toBeLessThanOrEqual(14);
    // The overflow marker replaces the last line.
    expect(lines[lines.length - 1].text).toBe("…");
  });

  it("clips an over-long line with an ellipsis", () => {
    const [p] = parseMarkdownLines("x".repeat(200), 14);
    expect(p.text.endsWith("…")).toBe(true);
    expect(p.text.length).toBeLessThanOrEqual(81);
  });
});

describe("layoutMarkdown", () => {
  it("stacks lines with increasing y and reports total height", () => {
    const { lines, height } = layoutMarkdown("# Title\n- a\n- b", 14);
    expect(lines).toHaveLength(3);
    expect(lines[0].y).toBe(0);
    expect(lines[1].y).toBeGreaterThan(lines[0].y);
    expect(lines[2].y).toBeGreaterThan(lines[1].y);
    expect(height).toBe(
      lines[0].height + lines[1].height + lines[2].height
    );
  });

  it("offsets list text past its bullet gutter", () => {
    const { lines } = layoutMarkdown("- item", 14);
    expect(lines[0].textOffset).toBeGreaterThan(lines[0].indent);
  });

  it("never returns an empty layout for blank input", () => {
    const { lines, height } = layoutMarkdown("", 14);
    expect(lines.length).toBe(1);
    expect(height).toBeGreaterThan(0);
  });
});
