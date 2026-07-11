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

// These run under the "node" project (no DOM), so measurement goes through the
// deterministic fallback: 8px per character, and 40px for the "empty" hint.

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
});
