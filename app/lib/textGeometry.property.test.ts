/**
 * Caret geometry on random multi-line text (node fallback measurement: 8px
 * per character, a character-count wrap estimate).
 *
 *  (wrapNodeText's own invariants live with it, in measureText.property.test.ts.)
 *
 *  - posToLineCol / lineColToPos: inverse of each other at every offset when
 *    only hard breaks exist; with soft wraps an offset inside consumed
 *    whitespace resolves to the end of its line, never past the offset;
 *  - nearestCol: within [0, length], non-decreasing in x, exact on a boundary;
 *  - verticalMove: null only off the first/last line, otherwise lands on the
 *    adjacent line at min(col, that line's length), and down-then-up returns
 *    to the same line.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  buildLineData,
  lineColToPos,
  measureOffsets,
  nearestCol,
  posToLineCol,
  verticalMove,
} from "./textGeometry";
import { wrapNodeText } from "./measureText";

const lineArb = fc.string({ maxLength: 70 }).map((s) => s.replace(/\n/g, " "));
const textArb = fc.array(lineArb, { minLength: 1, maxLength: 5 }).map((ls) => ls.join("\n"));

describe("posToLineCol / lineColToPos", () => {
  it("round-trip every offset with hard breaks only", () => {
    fc.assert(
      fc.property(textArb, fc.nat(), (text, n) => {
        const data = buildLineData(text, 14, false, Infinity);
        const pos = n % (text.length + 1);
        const lc = posToLineCol(data, pos);
        expect(lineColToPos(data, lc.line, lc.col)).toBe(pos);
        expect(lc.col).toBeLessThanOrEqual(data.lines[lc.line].length);
      })
    );
  });

  it("with soft wraps, never resolve past the offset and stay on its line", () => {
    fc.assert(
      fc.property(textArb, fc.nat(), fc.constantFrom(60, 120), (text, n, cap) => {
        const data = buildLineData(text, 14, false, cap);
        const pos = n % (text.length + 1);
        const lc = posToLineCol(data, pos);
        const back = lineColToPos(data, lc.line, lc.col);
        expect(back).toBeLessThanOrEqual(pos);
        expect(pos).toBeGreaterThanOrEqual(data.lineStarts[lc.line]);
        if (lc.line + 1 < data.lines.length) expect(pos).toBeLessThan(data.lineStarts[lc.line + 1]);
        // Inside the drawn text the mapping is exact.
        if (pos - data.lineStarts[lc.line] <= data.lines[lc.line].length) expect(back).toBe(pos);
      })
    );
  });
});

describe("nearestCol", () => {
  it("is within [0, length], non-decreasing in x, and exact on a caret boundary", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), fc.integer({ min: -50, max: 400 }), fc.nat({ max: 50 }), (line, x, dx) => {
        const offsets = measureOffsets(line);
        const a = nearestCol(offsets, x);
        const b = nearestCol(offsets, x + dx);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThanOrEqual(line.length);
        expect(b).toBeGreaterThanOrEqual(a);
        const c = a; // a boundary
        expect(nearestCol(offsets, offsets[c])).toBe(c);
      })
    );
  });
});

describe("verticalMove", () => {
  it("is null only off the ends, otherwise lands on the adjacent line at min(col, its length); down then up returns to the line", () => {
    fc.assert(
      fc.property(textArb, fc.nat(), fc.constantFrom(-1 as const, 1 as const), (text, n, dir) => {
        const data = buildLineData(text, 14, false, Infinity);
        const pos = n % (text.length + 1);
        const { line, col } = posToLineCol(data, pos);
        const moved = verticalMove(text, pos, dir);
        const target = line + dir;
        if (target < 0 || target >= data.lines.length) {
          expect(moved).toBeNull();
          return;
        }
        expect(moved).not.toBeNull();
        const lc = posToLineCol(data, moved!);
        expect(lc.line).toBe(target);
        expect(lc.col).toBe(Math.min(col, data.lines[target].length));
        const back = verticalMove(text, moved!, dir === 1 ? -1 : 1)!;
        expect(posToLineCol(data, back).line).toBe(line);
      })
    );
  });
});
