/**
 * Property-based tests for node text measurement.
 *
 * 2つのことを見ている。
 *
 * 1. **折り返しの整合**: `wrapNodeText` が返す視覚行と `lineStarts` は、
 *    ボックスの寸法・描画・キャレット位置の**共通の土台**（モジュールコメント
 *    の「the box, the drawn text and the caret can never disagree about where a
 *    line breaks」）。だから効くのは「各視覚行が、記録されたオフセットにある
 *    元テキストの実体である」こと。行の間に落ちてよいのは空白と改行だけ。
 * 2. **キャッシュが答えを変えないこと**: `wrapAt` は `_wrapCache` に貯め、
 *    4000件で丸ごと捨てる。つまり同じ入力への答えが「それまでに何を測ったか」に
 *    依存しうる形をしている。呼ぶ順番を変えても、キャッシュを溢れさせても、
 *    答えが変わらないことを確かめる。
 *
 * node では Canvas 2D が無いので文字数見積り経路（`estimatePieces`）が走る。
 * ここで検証するのは幅の実測値ではなく、折り返しの構造と箱の寸法規則。
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  DEFAULT_FONT_SIZE,
  lineHeightFor,
  measureNodeBox,
  nodeBoxHeight,
  nodeBoxWidth,
  NODE_MAX_CONTENT_WIDTH,
  NODE_PADDING,
  wrapNodeText,
  type MeasureOpts,
} from "./measureText";

/** 改行・空白・長い連続語を混ぜた、折り返しの分岐に届くテキスト。 */
const textArb = fc.oneof(
  fc.string({ maxLength: 60 }),
  fc
    .array(fc.constantFrom("hello", "a", "", "  ", "supercalifragilistic", "日本語のテキスト"), {
      maxLength: 8,
    })
    .map((ws) => ws.join(" ")),
  fc
    .array(fc.string({ maxLength: 20 }), { maxLength: 4 })
    .map((ls) => ls.join("\n")),
  fc.constantFrom("", "\n", "\n\n", " ", "x".repeat(300), "a b".repeat(80))
);

const optsArb: fc.Arbitrary<MeasureOpts> = fc.record(
  {
    fontSize: fc.integer({ min: 8, max: 64 }),
    bold: fc.boolean(),
    maxWidth: fc.oneof(
      fc.constant(NODE_MAX_CONTENT_WIDTH),
      fc.constant(Infinity),
      fc.integer({ min: 20, max: 600 })
    ),
  },
  { requiredKeys: [] }
);

describe("wrapNodeText", () => {
  it("lays every visual line at its recorded offset, swallowing only whitespace between them", () => {
    fc.assert(
      fc.property(textArb, optsArb, (text, opts) => {
        const { lines, lineStarts, visualText } = wrapNodeText(text, opts);

        expect(lines.length).toBe(lineStarts.length);
        expect(lines.length).toBeGreaterThanOrEqual(1);
        expect(lineStarts[0]).toBe(0);
        expect(visualText).toBe(lines.join("\n"));

        for (let i = 0; i < lines.length; i++) {
          const start = lineStarts[i];
          // これがキャレットの土台: 視覚行は元テキストのその位置の実体。
          expect(text.slice(start, start + lines[i].length), `line ${i} of ${JSON.stringify(text)}`).toBe(
            lines[i]
          );
          if (i > 0) expect(start).toBeGreaterThan(lineStarts[i - 1]);
          // 行と行の間で消えてよいのは、消費された "\n" と折り返しが食べた
          // 空白だけ（文字が消えたらキャレットが元テキストとずれる）。
          const gap = text.slice(start + lines[i].length, lineStarts[i + 1] ?? text.length);
          expect(gap, `gap after line ${i} of ${JSON.stringify(text)}`).toMatch(/^\s*$/);
        }
      }),
      { numRuns: 300 }
    );
  });

  it("wraps only within the cap: an infinite cap gives exactly the hard lines", () => {
    fc.assert(
      fc.property(textArb, optsArb, (text, opts) => {
        const { lines, width } = wrapNodeText(text, opts);
        const cap = opts.maxWidth ?? NODE_MAX_CONTENT_WIDTH;
        if (cap === Infinity) {
          // 上限が無ければソフトラップは起きない。
          expect(lines).toEqual(text.split("\n"));
          return;
        }
        // ソフトラップは行を増やすだけ。減らすことはない。
        expect(lines.length).toBeGreaterThanOrEqual(text.split("\n").length);
        expect(width).toBeGreaterThanOrEqual(0);
        // 「横に伸びるのは上限まで、あとは下に伸びる」。ただし2つの例外があり、
        // どちらも上限を1文字ぶんまでしか超えない:
        //  - 行末の空白はキャレットが座れるので残し、幅にも数える（CSS の
        //    hanging space と違って測り込む）。生成テキストに末尾空白がある
        //    ときはこの検査を外す。
        //  - 1文字より細くは割れないので、フォントが上限より大きければ超える。
        const oneChar = opts.fontSize ?? DEFAULT_FONT_SIZE;
        if (!text.split("\n").some((l) => /\s$/.test(l))) {
          expect(width, `overflowed ${cap} with ${JSON.stringify(lines)}`).toBeLessThanOrEqual(
            Math.max(cap, oneChar) + 1e-9
          );
        }
      }),
      { numRuns: 300 }
    );
  });
});

describe("the wrap cache never changes the answer", () => {
  /** 呼び出しの identity（キャッシュキーになる組）。 */
  const callArb = fc.tuple(textArb, optsArb);

  it("is order-independent: the same call answers the same however many others ran first", () => {
    fc.assert(
      fc.property(fc.array(callArb, { minLength: 1, maxLength: 12 }), (calls) => {
        // 素直な順で1回ずつ。
        const first = calls.map(([t, o]) => wrapNodeText(t, o));
        // 逆順に、しかも各呼び出しを2回。キャッシュの状態はまるで別物になる。
        const again: ReturnType<typeof wrapNodeText>[] = [];
        for (let i = calls.length - 1; i >= 0; i--) {
          const [t, o] = calls[i];
          wrapNodeText(t, o);
          again[i] = wrapNodeText(t, o);
        }
        for (let i = 0; i < calls.length; i++) expect(again[i]).toEqual(first[i]);
      }),
      { numRuns: 100 }
    );
  });

  it("answers the same after the cache is flushed by overflow", () => {
    const text = "the quick brown fox jumps over the lazy dog, repeatedly and at length";
    const opts = { fontSize: 14, bold: false, maxWidth: 200 };
    const before = wrapNodeText(text, opts);
    // `wrapAt` は 4000 件を超えると丸ごと捨てる。跨いでも答えは同じでなければ
    // ならない（キャッシュは速度のためだけのもの）。
    for (let i = 0; i < 4200; i++) wrapNodeText(`filler ${i}`, opts);
    expect(wrapNodeText(text, opts)).toEqual(before);
  });
});

describe("box geometry", () => {
  it("never returns a box under the floors, and grows with the content", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 2000, noNaN: true }),
        fc.double({ min: 0, max: 2000, noNaN: true }),
        fc.boolean(),
        (a, b, isRoot) => {
          const [small, big] = a <= b ? [a, b] : [b, a];
          // 下限（root は 100、それ以外は 80、高さは 32）。
          expect(nodeBoxWidth(small, true)).toBeGreaterThanOrEqual(100);
          expect(nodeBoxWidth(small, false)).toBeGreaterThanOrEqual(80);
          expect(nodeBoxHeight(small)).toBeGreaterThanOrEqual(32);
          // 中身が広く（高く）なって箱が縮むことはない。
          expect(nodeBoxWidth(big, isRoot)).toBeGreaterThanOrEqual(nodeBoxWidth(small, isRoot));
          expect(nodeBoxHeight(big)).toBeGreaterThanOrEqual(nodeBoxHeight(small));
          // 下限に当たっていなければ、ちょうど padding 2つ分ぶん広い。
          if (big + NODE_PADDING * 2 >= 100) {
            expect(nodeBoxWidth(big, true)).toBe(big + NODE_PADDING * 2);
          }
          // root のほうが狭いことはない。
          expect(nodeBoxWidth(small, true)).toBeGreaterThanOrEqual(nodeBoxWidth(small, false));
        }
      )
    );
  });

  it("reports the wrapped line count and a height that follows it", () => {
    fc.assert(
      fc.property(textArb, optsArb, (text, opts) => {
        const wrapped = wrapNodeText(text, opts);
        const box = measureNodeBox(text, opts);
        expect(box.lineCount).toBe(wrapped.lines.length);
        expect(box.width).toBe(wrapped.width);
        // 下限（32px）か、行数ぶんの高さ + 縦パディングのどちらか大きい方。
        const lh = lineHeightFor(opts.fontSize ?? DEFAULT_FONT_SIZE);
        expect(box.height).toBe(Math.max(32, box.lineCount * lh + 14));
        // 二度測っても同じ（キャッシュ経路と初回で食い違わない）。
        expect(measureNodeBox(text, opts)).toEqual(box);
      }),
      { numRuns: 300 }
    );
  });

  it("scales the line height from the 14px baseline, monotonically", () => {
    expect(lineHeightFor(DEFAULT_FONT_SIZE)).toBe(18);
    fc.assert(
      fc.property(fc.integer({ min: 8, max: 64 }), fc.integer({ min: 8, max: 64 }), (a, b) => {
        const [small, big] = a <= b ? [a, b] : [b, a];
        expect(lineHeightFor(big)).toBeGreaterThanOrEqual(lineHeightFor(small));
        expect(Number.isInteger(lineHeightFor(small))).toBe(true);
      })
    );
  });
});
