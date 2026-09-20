/**
 * Property-based tests for the wheel gesture recognizer — the stateful half of
 * panZoom.
 *
 * `createWheelGestureRecognizer` はクロージャに「直前のデバイス」と「直前の
 * 時刻」を持つ本物の状態機械。単体では判別できないイベントは直前のバーストの
 * デバイスを受け継ぐので、**同じイベントでも履歴によって結果が変わる**。それが
 * 仕様どおりであること——そして履歴に依存してよいのは曖昧なイベントだけである
 * こと——をランダムなイベント列で確かめる。
 *
 * 純粋な変換側（`zoomAt` / `panBy` / `clampScale`）はここには無い。
 * `viewport.property.test.ts` が同じ関数を、こちらより強い（誤差なしの）形で
 * 総当たりしている。
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { createWheelGestureRecognizer, GESTURE_BURST_MS, type WheelInput } from "./panZoom";

/**
 * 何を送るかの指定。`timeStamp` は「直前から何 ms 空けるか」で持つので、
 * バーストの内と外を狙って生成できる。
 */
interface Ev {
  gap: number;
  ctrlKey: boolean;
  kind: "mouse-notch" | "mouse-fast" | "mouse-lines" | "pinch" | "pad-scroll" | "ambiguous";
}

const evArb: fc.Arbitrary<Ev> = fc.record({
  // GESTURE_BURST_MS の両側を必ず跨ぐ。
  gap: fc.constantFrom(0, 10, GESTURE_BURST_MS - 1, GESTURE_BURST_MS, GESTURE_BURST_MS + 50),
  ctrlKey: fc.boolean(),
  kind: fc.constantFrom(
    "mouse-notch",
    "mouse-fast",
    "mouse-lines",
    "pinch",
    "pad-scroll",
    "ambiguous"
  ),
});

/** 観測されている実値に対応する WheelInput（`detectDevice` のコメント参照）。 */
function inputFor(ev: Ev, timeStamp: number): WheelInput {
  const base = { deltaX: 0, deltaMode: 0, ctrlKey: ev.ctrlKey, timeStamp };
  switch (ev.kind) {
    case "mouse-notch": // 1ノッチ: ±120 かつ整数 deltaY → 単体では曖昧
      return { ...base, deltaY: 100, wheelDeltaY: -120 };
    case "mouse-fast": // 複数ノッチ: |wheelDeltaY| > 120 → 確実にマウス
      return { ...base, deltaY: 267.3, wheelDeltaY: -480 };
    case "mouse-lines": // deltaMode != 0 → 確実にマウス
      return { ...base, deltaY: 3, deltaMode: 1 };
    case "pinch": // ±120 に張り付き + 小数 deltaY → 確実にトラックパッド
      return { ...base, deltaY: 1.5, wheelDeltaY: 120 };
    case "pad-scroll": // 120 の倍数でない → 確実にトラックパッド
      return { ...base, deltaX: 2, deltaY: -7, wheelDeltaY: 21 };
    case "ambiguous": // wheelDeltaY なし・整数・縦のみ → 単体では曖昧
      return { ...base, deltaY: 40 };
  }
}

/** 単体で判定できるイベントか（できないものだけがバースト記憶を使う）。 */
const DEFINITE: Record<Ev["kind"], "mouse" | "trackpad" | null> = {
  "mouse-notch": null,
  ambiguous: null,
  "mouse-fast": "mouse",
  "mouse-lines": "mouse",
  pinch: "trackpad",
  "pad-scroll": "trackpad",
};

/** イベント列を認識器に流し、各手の (入力, 出力) を返す。 */
function drive(evs: Ev[]) {
  const recognize = createWheelGestureRecognizer();
  let t = 1000;
  return evs.map((ev) => {
    t += ev.gap;
    const input = inputFor(ev, t);
    return { ev, input, action: recognize(input) };
  });
}

describe("createWheelGestureRecognizer", () => {
  /**
   * 参照実装。`detectDevice` のビット判定を写したものではなく、**イベント種別の
   * 意味**（{@link DEFINITE}）とバーストの規則だけから答えを組み立てる。バースト
   * のデバイスは曖昧なイベントを跨いで伝播するので、1手前を見るだけでは書けない
   * ——履歴を畳む必要があることそのものが、この状態機械の性質。
   */
  function expectedActions(evs: Ev[]): ("pan" | "zoom")[] {
    let lastDevice: "mouse" | "trackpad" = "mouse";
    let lastTime = -Infinity;
    let t = 1000;
    return evs.map((ev) => {
      t += ev.gap;
      const detected = DEFINITE[ev.kind];
      const inBurst = t - lastTime < GESTURE_BURST_MS;
      const device: "mouse" | "trackpad" = detected ?? (inBurst ? lastDevice : "mouse");
      lastDevice = device;
      lastTime = t;
      // ctrl は常にズーム（ピンチもブラウザが ctrl+wheel として送る）。それ以外は
      // トラックパッドならパン、マウスならステップズーム。
      return ev.ctrlKey || device === "mouse" ? "zoom" : "pan";
    });
  }

  it("classifies every event by its own device when definite, and by the burst's when not", () => {
    fc.assert(
      fc.property(fc.array(evArb, { maxLength: 15 }), (evs) => {
        const actual = drive(evs).map((s) => s.action.type);
        expect(actual).toEqual(expectedActions(evs));
      }),
      { numRuns: 300 }
    );
  });

  it("keeps that memory per recognizer, so a fresh one always starts on mouse", () => {
    fc.assert(
      fc.property(fc.array(evArb, { minLength: 1, maxLength: 10 }), (evs) => {
        let t = 1000;
        for (const ev of evs) {
          t += ev.gap;
          // 1件だけを新しい認識器に流す = 履歴なし。曖昧なイベントは既定の
          // マウス扱いになり、判別できるイベントは変わらない。
          const solo = createWheelGestureRecognizer()(inputFor(ev, t))
            .type;
          expect(solo).toBe(expectedActions([ev])[0]);
        }
      }),
      { numRuns: 200 }
    );
  });

  it("reports a pan that follows the fingers and a zoom by a positive finite factor", () => {
    fc.assert(
      fc.property(fc.array(evArb, { maxLength: 15 }), (evs) => {
        for (const { input, action } of drive(evs)) {
          if (action.type === "pan") {
            // 内容が指について来るよう符号を反転（macOS のナチュラルスクロール）。
            expect(action.dx).toBe(-input.deltaX);
            expect(action.dy).toBe(-input.deltaY);
          } else {
            expect(action.factor).toBeGreaterThan(0);
            expect(Number.isFinite(action.factor)).toBe(true);
          }
        }
      }),
      { numRuns: 300 }
    );
  });
});
