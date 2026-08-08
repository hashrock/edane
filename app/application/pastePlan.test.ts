import { describe, it, expect } from "vitest";
import { planPaste, type PasteContext } from "./pastePlan";

const ctx = (over: Partial<PasteContext> = {}): PasteContext => ({
  editing: false,
  text: "",
  hasBranchJson: false,
  hasInternalClipboard: false,
  ...over,
});

describe("planPaste while editing", () => {
  it("is always a native text paste — no dialog, no node splitting", () => {
    expect(planPaste(ctx({ editing: true, text: "# Title\n- one\n- two" }))).toBe(
      "native"
    );
    expect(planPaste(ctx({ editing: true, text: "see [docs](https://x.dev)" }))).toBe(
      "native"
    );
    expect(planPaste(ctx({ editing: true, text: "a\n  b\n  c" }))).toBe("native");
    expect(planPaste(ctx({ editing: true, text: "plain" }))).toBe("native");
    expect(planPaste(ctx({ editing: true, text: "" }))).toBe("native");
  });

  it("does not let a branch payload hijack the caret", () => {
    expect(
      planPaste(
        ctx({
          editing: true,
          text: "- Alpha",
          hasBranchJson: true,
          hasInternalClipboard: true,
        })
      )
    ).toBe("native");
  });
});

describe("planPaste while selecting", () => {
  it("offers the Markdown dialog for Markdown-looking text", () => {
    expect(planPaste(ctx({ text: "# Title\n- one" }))).toBe("markdown-dialog");
    expect(planPaste(ctx({ text: "this is **bold**" }))).toBe("markdown-dialog");
  });

  it("prefers our own branch JSON over its Markdown text/plain twin", () => {
    expect(planPaste(ctx({ text: "- Alpha", hasBranchJson: true }))).toBe(
      "branch-json"
    );
  });

  it("pastes the internal branch clipboard when the text is not Markdown", () => {
    expect(planPaste(ctx({ text: "", hasInternalClipboard: true }))).toBe(
      "branch-clipboard"
    );
    // Markdown still wins: a cut/copied branch carries no text of its own.
    expect(
      planPaste(ctx({ text: "# Outside", hasInternalClipboard: true }))
    ).toBe("markdown-dialog");
  });

  it("turns plain (indented) text into nodes", () => {
    expect(planPaste(ctx({ text: "a\n  b" }))).toBe("text-as-nodes");
    expect(planPaste(ctx({ text: "one line" }))).toBe("text-as-nodes");
  });

  it("does nothing with an empty clipboard", () => {
    expect(planPaste(ctx())).toBe("none");
  });
});
