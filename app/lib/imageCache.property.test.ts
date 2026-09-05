/**
 * Property-based tests for the image cache.
 *
 * これはモジュール寿命の可変状態（URL→エントリの `Map` と購読者の `Set`）で、
 * 非同期の完了がいつどの順で来るか分からない。効く不変条件は3つ:
 *
 *   1. **単調性**: エントリは `loading → loaded | error` の一方向にしか進まない。
 *      いちど解決した URL が読み込み中に戻ることはない。
 *   2. **一度だけ読む**: 同じ URL を何度要求しても `Image` は1つしか作らない
 *      （キャンバスの再描画は毎フレーム `imageDisplaySize` を呼ぶので、ここが
 *      壊れると再描画のたびにネットワークへ行く）。
 *   3. **寸法の規則**: 読み込めた画像は縦横比を保ったまま
 *      `IMAGE_MAX_HEIGHT` と `NODE_MAX_CONTENT_WIDTH` の内側に収まり、
 *      拡大はされない。未解決・失敗は固定の箱。
 *
 * `Image` はグローバルに差し替えた偽物で、`onload` / `onerror` の発火を
 * テスト側が任意の順に握る。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fc from "fast-check";
import { NODE_MAX_CONTENT_WIDTH } from "./measureText";

/** 生成された偽 Image たち。`src` 代入で登録され、テストが完了を発火させる。 */
let created: FakeImage[] = [];

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  #src = "";
  get src() {
    return this.#src;
  }
  set src(v: string) {
    this.#src = v;
    created.push(this);
  }
}

/**
 * `imageCache` はモジュールレベルの Map を持つので、プロパティの試行ごとに
 * まっさらな状態が要る。`resetModules` + 動的 import で毎回作り直す。
 */
async function freshCache() {
  created = [];
  vi.resetModules();
  return import("./imageCache");
}

beforeEach(() => {
  (globalThis as any).Image = FakeImage;
});

afterEach(() => {
  delete (globalThis as any).Image;
});

/** 一件の画像の運命。成功なら自然サイズを持つ。 */
type Fate =
  | { kind: "load"; w: number; h: number }
  | { kind: "error" }
  | { kind: "pending" };

const fateArb: fc.Arbitrary<Fate> = fc.oneof(
  fc.record({
    kind: fc.constant("load" as const),
    w: fc.integer({ min: 1, max: 4000 }),
    h: fc.integer({ min: 1, max: 4000 }),
  }),
  fc.constant({ kind: "error" } as Fate),
  fc.constant({ kind: "pending" } as Fate)
);

const urlArb = fc.stringMatching(/^https:\/\/x\.test\/[a-z]{1,4}\.png$/);

describe("imageCache as a state machine", () => {
  it("only ever moves loading → loaded/error, and starts exactly one load per URL", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(urlArb, fateArb), { minLength: 1, maxLength: 8 }),
        fc.array(fc.nat(), { minLength: 1, maxLength: 12 }),
        async (entries, perm) => {
          const cache = await freshCache();
          // 同じ URL が複数回来ることを許す（最初の運命だけが効く）。
          const fateOf = new Map<string, Fate>();
          for (const [url, fate] of entries) if (!fateOf.has(url)) fateOf.set(url, fate);
          const urls = [...fateOf.keys()];

          // 各 URL を1〜2回要求する。要求回数によらず Image は1つ。
          for (const url of urls) {
            cache.getImageEntry(url);
            cache.getImageEntry(url);
            expect(cache.getImageEntry(url)?.status).toBe("loading");
          }
          expect(created.length, "one Image per URL").toBe(urls.length);

          let notified = 0;
          const unsubscribe = cache.subscribeImages(() => notified++);

          // 完了を任意の順で発火する。
          const pending = created.map((img, i) => ({ img, url: urls[i] }));
          let expectedNotifications = 0;
          for (let step = 0; pending.length > 0; step++) {
            const [{ img, url }] = pending.splice(perm[step % perm.length] % pending.length, 1);
            const fate = fateOf.get(url)!;
            if (fate.kind === "pending") continue;
            const before = cache.getImageEntry(url)!;
            expect(before.status).toBe("loading");
            if (fate.kind === "load") {
              img.naturalWidth = fate.w;
              img.naturalHeight = fate.h;
              img.onload?.();
            } else {
              img.onerror?.();
            }
            expectedNotifications++;
            expect(notified).toBe(expectedNotifications);
            // 1. 解決したら loading には戻らない。何度読んでも同じエントリ。
            const after = cache.getImageEntry(url)!;
            expect(after.status).toBe(fate.kind === "load" ? "loaded" : "error");
            expect(cache.getImageEntry(url)).toBe(after);
          }

          unsubscribe();
          // 解約後は通知が来ない。
          const quiet = notified;
          for (const img of created) img.onerror?.();
          expect(notified).toBe(quiet);
          // 2. 追加の要求でも Image は増えない。
          for (const url of urls) cache.getImageEntry(url);
          expect(created.length).toBe(urls.length);
        }
      ),
      { numRuns: 60 }
    );
  });

  it("fits a loaded image inside both caps with its aspect ratio intact, never enlarging it", async () => {
    await fc.assert(
      fc.asyncProperty(
        urlArb,
        fc.integer({ min: 1, max: 6000 }),
        fc.integer({ min: 1, max: 6000 }),
        async (url, w, h) => {
          const cache = await freshCache();
          // 未解決はプレースホルダの固定箱。
          const loading = cache.imageDisplaySize(url);
          expect(loading.status).toBe("loading");
          expect(loading.w).toBeGreaterThan(0);

          const img = created[0];
          img.naturalWidth = w;
          img.naturalHeight = h;
          img.onload?.();

          const shown = cache.imageDisplaySize(url);
          expect(shown.status).toBe("loaded");
          // 3. 両方の上限の内側に収まる。`natural * (cap / natural)` の丸めで
          //    最終ビットぶん超えることがあるので ULP 相当の遊びを見る（1px の
          //    丸め下限も許す）。
          const EPS = 1e-9;
          expect(shown.h).toBeLessThanOrEqual(Math.max(1, cache.IMAGE_MAX_HEIGHT) + EPS);
          expect(shown.w).toBeLessThanOrEqual(Math.max(1, NODE_MAX_CONTENT_WIDTH) + EPS);
          // 拡大はしない。
          expect(shown.w).toBeLessThanOrEqual(Math.max(1, w) + EPS);
          expect(shown.h).toBeLessThanOrEqual(Math.max(1, h) + EPS);
          // 縦横比は保たれる（1px 下限に当たった場合を除く）。
          if (shown.w > 1 && shown.h > 1) {
            expect(Math.abs(shown.w / shown.h - w / h)).toBeLessThan(1e-6 * (w / h + 1));
          }
          // 上限に当たっていない小さな画像は原寸のまま。
          if (h <= cache.IMAGE_MAX_HEIGHT && w <= NODE_MAX_CONTENT_WIDTH) {
            expect(shown.w).toBe(w);
            expect(shown.h).toBe(h);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it("falls back to a fixed box for an errored image, and for every URL when there is no Image at all", async () => {
    const cache = await freshCache();
    const url = "https://x.test/broken.png";
    cache.getImageEntry(url);
    created[0].onerror?.();
    const errored = cache.imageDisplaySize(url);
    expect(errored.status).toBe("error");
    expect(errored.w).toBeGreaterThan(0);
    expect(errored.h).toBeGreaterThan(0);

    // SSR / node: Image が無い環境ではプレースホルダに落ち、例外は投げない。
    delete (globalThis as any).Image;
    const ssr = await freshCache();
    expect(ssr.getImageEntry("https://x.test/a.png")).toBeUndefined();
    expect(ssr.imageDisplaySize("https://x.test/a.png").status).toBe("loading");
    // 空文字列は URL ではないので何も起こさない。
    expect(ssr.getImageEntry("")).toBeUndefined();
  });
});
