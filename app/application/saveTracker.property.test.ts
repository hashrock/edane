/**
 * Property-based tests for the autosave state machine.
 *
 * 検証の主役は**応答の到着順**。編集と保存発行を交互に行い、飛んでいる保存の
 * 完了を任意の順で配送するドライバを振って、
 *
 *   1. 到着順に依存しない（同じ発行列なら、完了の順列をどう入れ替えても
 *      baseline は同じ）— 過去に巻き戻しバグを出した箇所そのもの
 *   2. baseline は「最後に発行された、成功する保存」の内容に収束する
 *   3. `acked` は単調非減少で、発行数を超えない
 *   4. 失敗は何も動かさない
 *   5. 静止したあとの `isDirty` は今の内容と baseline の一致だけで決まる
 *
 * を確かめる。冪等性とバックオフは短い単独のプロパティとして別に置く。
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  acknowledgeSave,
  AUTOSAVE_DELAY_MS,
  AUTOSAVE_MAX_DELAY_MS,
  beginSave,
  initialSaveTracker,
  isDirty,
  isUntracked,
  nextRetryDelay,
  untrackedSave,
} from "./saveTracker";

/**
 * ドライバの一手。編集は内容を変え、保存は今の内容を発行する。成否は発行時に
 * 決めておく（サーバー側の運命であって、応答がいつ返るかとは独立）——こうする
 * ことで、到着順だけを入れ替えた再生が同じ成否の集合を持つ。
 */
type Step =
  | { kind: "edit" }
  | { kind: "save"; ok: boolean }
  /** 飛んでいる保存のうち `n` 番目を完了させる。 */
  | { kind: "settle"; n: number };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.constant({ kind: "edit" } as Step),
  fc.record({ kind: fc.constant("save" as const), ok: fc.boolean() }),
  fc.record({ kind: fc.constant("settle" as const), n: fc.nat() })
);

interface Inflight {
  seq: number;
  content: string;
  ok: boolean;
}

/**
 * 一連の操作を実行し、最後まで飛んだままの保存も片付けて静止させる。`settle`
 * の `n` が「今飛んでいる保存のどれが返ってくるか」なので、そこだけ差し替えれば
 * 同じ発行列を別の到着順で再生できる（{@link shuffled}）。
 */
function run(steps: Step[], initial: string) {
  let tracker = initialSaveTracker(initial);
  let content = initial;
  let edits = 0;
  const inflight: Inflight[] = [];
  /** 成功する保存のうち最後に発行されたものの内容 = baseline の収束先。 */
  let winner = initial;

  // 失敗応答は状態機械に触れない（呼び出し側が acknowledgeSave を呼ばない）。
  const settle = (entry: Inflight) => {
    if (entry.ok) tracker = acknowledgeSave(tracker, entry.seq, entry.content).tracker;
  };

  for (const step of steps) {
    const before = tracker;
    switch (step.kind) {
      case "edit":
        content = `edit-${edits++}`;
        break;
      case "save": {
        tracker = beginSave(tracker);
        expect(tracker.issued).toBe(before.issued + 1);
        // 発行だけでは保存済みの起点は動かない。
        expect(tracker.baseline).toBe(before.baseline);
        expect(tracker.acked).toBe(before.acked);
        inflight.push({ seq: tracker.issued, content, ok: step.ok });
        if (step.ok) winner = content;
        break;
      }
      case "settle": {
        if (inflight.length === 0) break;
        const [entry] = inflight.splice(step.n % inflight.length, 1);
        settle(entry);
        // 4. 失敗は何も動かさない。
        if (!entry.ok) expect(tracker).toBe(before);
        break;
      }
    }
    // 3. `acked` は単調非減少で、発行数を超えない。
    expect(tracker.acked).toBeGreaterThanOrEqual(before.acked);
    expect(tracker.acked).toBeLessThanOrEqual(tracker.issued);
  }
  // 残っている保存も（発行時に決めた成否で）片付けて静止させる。
  for (const entry of inflight.splice(0)) settle(entry);
  return { tracker, content, winner };
}

/** 完了の到着順だけを入れ替えた同じ発行列。 */
function shuffled(steps: Step[], perm: number[]): Step[] {
  let i = 0;
  return steps.map((s) => (s.kind === "settle" ? { ...s, n: perm[i++ % perm.length] } : s));
}

const stepsArb = fc.array(stepArb, { maxLength: 20 });

describe("saveTracker under arbitrary completion orderings", () => {
  it("converges on the newest successful save's content, whatever order the responses land in", () => {
    fc.assert(
      fc.property(stepsArb, fc.array(fc.nat(), { minLength: 1, maxLength: 20 }), (steps, perm) => {
        const a = run(steps, "initial");
        const b = run(shuffled(steps, perm), "initial");
        // 1 + 2. 応答の順列を変えても、最後に発行された「成功する」保存の内容に
        // 収束する。成功が一件も無ければ初期内容のまま。
        expect(a.tracker.baseline).toBe(a.winner);
        expect(b.tracker.baseline).toBe(a.winner);
        expect(a.tracker.acked).toBe(b.tracker.acked);
        // 5. 静止後の未保存判定は、今の内容と baseline の一致だけで決まる。
        expect(isDirty(a.tracker, a.content)).toBe(a.content !== a.winner);
        expect(isDirty(a.tracker, `${a.content}!`)).toBe(true);
      }),
      { numRuns: 300 }
    );
  });

  it("ignores a completion it has already taken (duplicate delivery, or an older save landing late)", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (first, second) => {
        const issued = beginSave(beginSave(initialSaveTracker("initial")));
        const newest = acknowledgeSave(issued, 2, second);
        expect(newest.accepted).toBe(true);
        for (const stale of [
          acknowledgeSave(newest.tracker, 2, second), // 同じ応答の二重配送
          acknowledgeSave(newest.tracker, 1, first), // 古い保存が遅れて到着
        ]) {
          expect(stale.accepted).toBe(false);
          expect(stale.tracker).toBe(newest.tracker);
        }
      })
    );
  });

  it("stays quiet when there is nothing to track (guest note / read-only)", () => {
    fc.assert(
      fc.property(fc.string(), (content) => {
        expect(isUntracked(untrackedSave)).toBe(true);
        expect(isDirty(untrackedSave, content)).toBe(false);
        expect(isUntracked(initialSaveTracker(content))).toBe(false);
      })
    );
  });
});

describe("autosave retry backoff", () => {
  it("grows monotonically from the debounce delay and saturates at the cap", () => {
    fc.assert(
      fc.property(fc.nat({ max: 20 }), (retries) => {
        let delay: number = AUTOSAVE_DELAY_MS;
        for (let i = 0; i < retries; i++) {
          const next = nextRetryDelay(delay);
          expect(next).toBeGreaterThanOrEqual(delay);
          expect(next).toBeLessThanOrEqual(AUTOSAVE_MAX_DELAY_MS);
          delay = next;
        }
        // 伸び続けはしない: 数回で必ず上限に落ち着く。
        if (retries >= 4) expect(delay).toBe(AUTOSAVE_MAX_DELAY_MS);
      })
    );
  });
});
