import { describe, it, expect } from "vitest";
import { markdownTitle, markdownLineCount, MD_TITLE_MAX } from "./markdownCard";

describe("markdownTitle", () => {
  it("uses the first heading, stripped of its marker", () => {
    expect(markdownTitle("# 設計メモ\n\n本文")).toBe("設計メモ");
    expect(markdownTitle("### Deep\ntext")).toBe("Deep");
  });

  it("falls back to the first non-empty line", () => {
    expect(markdownTitle("\n\n最初の行\n次の行")).toBe("最初の行");
  });

  it("strips list / quote markers and inline decorations", () => {
    expect(markdownTitle("- **重要** な項目")).toBe("重要 な項目");
    expect(markdownTitle("> 引用文")).toBe("引用文");
    expect(markdownTitle("1. 手順")).toBe("手順");
    expect(markdownTitle("`code` first")).toBe("code first");
  });

  it("clips a long title with an ellipsis", () => {
    const long = "あ".repeat(60);
    const title = markdownTitle(long);
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBe(MD_TITLE_MAX + 1);
  });

  it("returns a placeholder for empty input", () => {
    expect(markdownTitle("")).toBe("無題のMarkdown");
    expect(markdownTitle("\n   \n")).toBe("無題のMarkdown");
  });
});

describe("markdownLineCount", () => {
  it("counts only non-blank lines", () => {
    expect(markdownLineCount("# A\n\n- x\n- y\n")).toBe(3);
    expect(markdownLineCount("")).toBe(0);
    expect(markdownLineCount("one")).toBe(1);
  });
});
