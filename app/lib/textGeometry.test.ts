import { describe, it, expect } from "vitest";
import {
  measureOffsets,
  measureEmptyWidth,
  buildLineData,
  posToLineCol,
  lineColToPos,
  lineDataWidth,
  nearestCol,
  verticalMove,
} from "./textGeometry";
import { wrapNodeText } from "./measureText";

// These run under the "node" project (no DOM), so measurement goes through the
// deterministic fallback: 8px per character, and 40px for the "empty" hint.
// Soft wrapping uses its own estimate, so ask it how many characters of an
// unbroken run fit on one line rather than restating the factor here.
const PER_LINE = wrapNodeText("x".repeat(2000)).lines[0].length;

describe("measureOffsets (fallback)", () => {
  it("returns cumulative prefix widths starting at 0", () => {
    expect(measureOffsets("abc")).toEqual([0, 8, 16, 24]);
  });
  it("returns [0] for empty text", () => {
    expect(measureOffsets("")).toEqual([0]);
  });
});

describe("measureEmptyWidth (fallback)", () => {
  it("is the placeholder estimate", () => {
    expect(measureEmptyWidth()).toBe(40);
  });
});

describe("buildLineData", () => {
  it("splits on newlines and tracks line start offsets", () => {
    const data = buildLineData("ab\ncde");
    expect(data.lines).toEqual(["ab", "cde"]);
    expect(data.lineStarts).toEqual([0, 3]); // "ab" + consumed "\n"
    expect(data.lineHeight).toBe(18); // lineHeightFor(14)
  });

  it("soft-wraps at the content cap, with offsets for every visual line", () => {
    const text = "x".repeat(PER_LINE * 2);
    const data = buildLineData(text);
    expect(data.lines.length).toBe(2);
    // One offsets array per VISUAL line, so the caret can be placed on both.
    expect(data.lineOffsets.length).toBe(2);
    expect(data.lineStarts).toEqual([0, PER_LINE]);
  });

  it("breaks on hard newlines only when the cap is Infinity", () => {
    const data = buildLineData("x".repeat(PER_LINE * 2), 14, false, Infinity);
    expect(data.lines.length).toBe(1);
  });
});

describe("caret round-trip across a soft wrap", () => {
  const text = "x".repeat(PER_LINE * 2);
  const data = buildLineData(text);

  it("maps every offset to a line/col that maps back", () => {
    for (let pos = 0; pos <= text.length; pos++) {
      const { line, col } = posToLineCol(data, pos);
      expect(lineColToPos(data, line, col)).toBe(pos);
    }
  });

  it("puts the first character of the second visual line on line 1", () => {
    expect(posToLineCol(data, PER_LINE)).toEqual({ line: 1, col: 0 });
  });
});

describe("posToLineCol / lineColToPos round-trip", () => {
  const data = buildLineData("ab\ncde");
  it("maps an absolute offset to line + column", () => {
    expect(posToLineCol(data, 4)).toEqual({ line: 1, col: 1 }); // 'd'
  });
  it("clamps a column past the line end", () => {
    expect(lineColToPos(data, 1, 99)).toBe(6); // start 3 + len 3
  });
  it("round-trips", () => {
    const { line, col } = posToLineCol(data, 5);
    expect(lineColToPos(data, line, col)).toBe(5);
  });
});

describe("lineDataWidth", () => {
  it("is the widest line's measured width", () => {
    // "ab"=16px, "cde"=24px
    expect(lineDataWidth(buildLineData("ab\ncde"))).toBe(24);
  });
});

describe("nearestCol", () => {
  it("snaps to the closest caret offset", () => {
    expect(nearestCol([0, 8, 16, 24], 15)).toBe(2); // 16 is closest to 15
  });
  it("returns 0 for missing offsets", () => {
    expect(nearestCol(undefined, 10)).toBe(0);
  });
});

describe("verticalMove", () => {
  it("keeps the column when moving to an adjacent line", () => {
    // pos 1 = line 0 col 1; move down → line 1 col 1 → offset 4
    expect(verticalMove("ab\ncde", 1, 1)).toBe(4);
  });
  it("returns null past the first line", () => {
    expect(verticalMove("ab\ncde", 1, -1)).toBeNull();
  });
  it("returns null past the last line", () => {
    expect(verticalMove("ab\ncde", 4, 1)).toBeNull();
  });
  it("ignores soft wraps so canvas and outline step identically", () => {
    // A long single-line node wraps visually on the canvas, but ↑/↓ must still
    // leave the node in one press — a soft wrap sits elsewhere in the outline.
    const long = "x".repeat(PER_LINE * 3);
    expect(verticalMove(long, 0, 1)).toBeNull();
    expect(verticalMove(long, long.length, -1)).toBeNull();
  });
});
