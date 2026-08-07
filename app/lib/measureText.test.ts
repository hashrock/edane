import { describe, it, expect } from "vitest";
import {
  wrapNodeText,
  measureNodeBox,
  nodeBoxWidth,
  NODE_MAX_CONTENT_WIDTH,
  NODE_PADDING,
  DEFAULT_FONT_SIZE,
  LINE_HEIGHT,
} from "./measureText";

// These run under the "node" project (no DOM), so wrapping goes through the
// deterministic character estimate: fontSize * 0.6 px per character.
const CHAR_W = DEFAULT_FONT_SIZE * 0.6;
const PER_LINE = Math.floor(NODE_MAX_CONTENT_WIDTH / CHAR_W);

/** A single unbroken run of `n` characters (no space to break on). */
const run = (n: number) => "x".repeat(n);

describe("wrapNodeText", () => {
  it("leaves short text on one line", () => {
    const w = wrapNodeText("hello");
    expect(w.lines).toEqual(["hello"]);
    expect(w.lineStarts).toEqual([0]);
  });

  it("splits on hard newlines and tracks their offsets", () => {
    const w = wrapNodeText("ab\ncde");
    expect(w.lines).toEqual(["ab", "cde"]);
    expect(w.lineStarts).toEqual([0, 3]); // "ab" + the consumed "\n"
  });

  it("soft-wraps a line that exceeds the content cap", () => {
    const w = wrapNodeText(run(PER_LINE * 2 + 3));
    expect(w.lines.length).toBe(3);
    expect(w.width).toBeLessThanOrEqual(NODE_MAX_CONTENT_WIDTH);
  });

  it("keeps line starts contiguous across a soft wrap", () => {
    const text = run(PER_LINE * 2);
    const w = wrapNodeText(text);
    // Every line starts exactly where the previous one ended: no character of
    // an unbroken run is dropped, so the caret can address all of them.
    w.lines.forEach((line, i) => {
      expect(text.slice(w.lineStarts[i], w.lineStarts[i] + line.length)).toBe(
        line
      );
    });
    expect(w.lines.join("")).toBe(text);
  });

  it("prefers a space over a mid-word break, and hangs that space", () => {
    const word = run(10);
    const text = Array(12).fill(word).join(" ");
    const w = wrapNodeText(text);
    expect(w.lines.length).toBeGreaterThan(1);
    for (let i = 0; i < w.lines.length; i++) {
      // No line ends mid-word…
      expect(w.lines[i].endsWith("x")).toBe(true);
      // …and the character a break consumed is the space itself.
      if (i > 0) expect(text[w.lineStarts[i] - 1]).toBe(" ");
    }
  });

  it("wraps sooner for a bigger font", () => {
    const text = run(PER_LINE);
    expect(wrapNodeText(text).lines.length).toBe(1);
    expect(wrapNodeText(text, { fontSize: 28 }).lines.length).toBeGreaterThan(1);
  });

  it("honours an explicit narrower cap", () => {
    const w = wrapNodeText(run(40), { maxWidth: 100 });
    expect(w.lines.length).toBeGreaterThan(1);
    expect(w.width).toBeLessThanOrEqual(100);
  });

  it("breaks on hard newlines only when the cap is Infinity", () => {
    const w = wrapNodeText(run(PER_LINE * 3), { maxWidth: Infinity });
    expect(w.lines.length).toBe(1);
  });

  it("keeps an empty string as a single empty line", () => {
    expect(wrapNodeText("").lines).toEqual([""]);
    expect(wrapNodeText("").lineStarts).toEqual([0]);
  });
});

describe("measureNodeBox", () => {
  it("never reports a width past the content cap", () => {
    expect(measureNodeBox(run(500)).width).toBeLessThanOrEqual(
      NODE_MAX_CONTENT_WIDTH
    );
  });

  it("grows in height instead: a wrapped line counts as a line", () => {
    const one = measureNodeBox(run(10));
    const many = measureNodeBox(run(PER_LINE * 3));
    expect(many.lineCount).toBe(3);
    expect(many.height).toBe(one.height + 2 * LINE_HEIGHT);
  });

  it("bounds the whole node box, padding included", () => {
    const box = measureNodeBox(run(500));
    expect(nodeBoxWidth(box.width, true)).toBeLessThanOrEqual(
      NODE_MAX_CONTENT_WIDTH + NODE_PADDING * 2
    );
  });
});
