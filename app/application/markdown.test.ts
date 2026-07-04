import { describe, it, expect } from "vitest";
import { looksLikeMarkdown, markdownToModel, modelToMarkdown } from "./markdown";
import type { MindMapModel } from "../domain/model";

/** Flatten a node's immediate child texts for concise assertions. */
const childTexts = (n: MindMapModel) => n.children.map((c) => c.text);

describe("looksLikeMarkdown", () => {
  it("detects headings, lists, quotes, code fences and tables", () => {
    expect(looksLikeMarkdown("# Title")).toBe(true);
    expect(looksLikeMarkdown("- item")).toBe(true);
    expect(looksLikeMarkdown("1. item")).toBe(true);
    expect(looksLikeMarkdown("> quote")).toBe(true);
    expect(looksLikeMarkdown("```\ncode\n```")).toBe(true);
    expect(looksLikeMarkdown("| a | b |\n| - | - |")).toBe(true);
    expect(looksLikeMarkdown("see [docs](https://x.dev)")).toBe(true);
    expect(looksLikeMarkdown("this is **bold** text")).toBe(true);
  });

  it("does not flag plain text, URLs or indented prose", () => {
    expect(looksLikeMarkdown("just a sentence")).toBe(false);
    expect(looksLikeMarkdown("https://example.com/a-b")).toBe(false);
    expect(looksLikeMarkdown("hello - world")).toBe(false); // dash mid-line
    expect(looksLikeMarkdown("  indented\n    more")).toBe(false);
    expect(looksLikeMarkdown("")).toBe(false);
  });
});

describe("markdownToModel", () => {
  it("nests heading levels", () => {
    const root = markdownToModel("# A\n## B\ncontent\n# C");
    expect(childTexts(root)).toEqual(["A", "C"]);
    const a = root.children[0];
    expect(childTexts(a)).toEqual(["B"]);
    expect(childTexts(a.children[0])).toEqual(["content"]);
  });

  it("nests list items under a heading and by indentation", () => {
    const root = markdownToModel("# List\n- one\n- two\n  - two-a\n- three");
    const list = root.children[0];
    expect(childTexts(list)).toEqual(["one", "two", "three"]);
    const two = list.children[1];
    expect(childTexts(two)).toEqual(["two-a"]);
  });

  it("strips inline decorations", () => {
    const root = markdownToModel("- **bold** and [link](https://x.dev) and `code`");
    expect(root.children[0].text).toBe("bold and link and code");
  });

  it("collapses a fenced code block into one verbatim node", () => {
    const root = markdownToModel("# Code\n```js\nconst a = 1;\nconst b = 2;\n```");
    const code = root.children[0].children[0];
    expect(code.text).toContain("const a = 1;");
    expect(code.text).toContain("const b = 2;");
  });

  it("handles content before any heading as top-level nodes", () => {
    const root = markdownToModel("intro line\n- a\n- b");
    expect(childTexts(root)).toEqual(["intro line", "a", "b"]);
  });

  it("assigns fresh ids to every node", () => {
    const root = markdownToModel("# A\n- x\n- y");
    const ids = new Set<string>();
    const walk = (n: MindMapModel) => {
      ids.add(n.id);
      n.children.forEach(walk);
    };
    walk(root);
    // root + A + x + y = 4 distinct ids
    expect(ids.size).toBe(4);
  });
});

describe("modelToMarkdown", () => {
  const node = (
    text: string,
    children: MindMapModel[] = [],
    extra: Partial<MindMapModel> = {}
  ): MindMapModel => ({ id: text, text, children, ...extra });

  it("renders a subtree as a nested bullet list", () => {
    const tree = node("Root", [
      node("A", [node("A1"), node("A2")]),
      node("B"),
    ]);
    expect(modelToMarkdown(tree)).toBe(
      ["- Root", "  - A", "    - A1", "    - A2", "  - B"].join("\n")
    );
  });

  it("wraps bold text in **", () => {
    const tree = node("Root", [node("strong", [], { bold: true })]);
    expect(modelToMarkdown(tree)).toBe("- Root\n  - **strong**");
  });

  it("renders image and link nodes with Markdown syntax", () => {
    const tree = node("Root", [
      node("https://x.dev/a.png", [], { type: "image" }),
      node("https://x.dev/", [], { type: "link", linkTitle: "Example" }),
    ]);
    expect(modelToMarkdown(tree)).toBe(
      [
        "- Root",
        "  - ![](https://x.dev/a.png)",
        "  - [Example](https://x.dev/)",
      ].join("\n")
    );
  });

  it("falls back to the raw URL when a link has no title", () => {
    const tree = node("https://x.dev/", [], { type: "link" });
    expect(modelToMarkdown(tree)).toBe("- [https://x.dev/](https://x.dev/)");
  });

  it("collapses newlines in a markdown node onto its bullet line", () => {
    const tree = node("# Title\n\nbody", [], { type: "markdown" });
    expect(modelToMarkdown(tree)).toBe("- # Title body");
  });

  it("round-trips the hierarchy back through markdownToModel", () => {
    const tree = node("Root", [node("A", [node("A1")]), node("B")]);
    const md = modelToMarkdown(tree);
    const back = markdownToModel(md);
    // markdownToModel returns a synthetic root whose children are the top items.
    expect(back.children.map((c) => c.text)).toEqual(["Root"]);
    expect(back.children[0].children.map((c) => c.text)).toEqual(["A", "B"]);
    expect(back.children[0].children[0].children.map((c) => c.text)).toEqual([
      "A1",
    ]);
  });
});
