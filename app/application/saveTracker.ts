/**
 * Application layer: autosave bookkeeping as a pure state machine.
 *
 * 保存は非同期で、編集中に前の保存がまだ飛んでいることがある。つまり複数の
 * 保存が同時に走り、**応答は発行順に返るとは限らない**。「どこまで保存済みか」
 * （= baseline）をこの順序ゆらぎの中で正しく保つのが、この状態機械の唯一の
 * 仕事である。
 *
 * 追い越しの規則は2つあり、見ているものが違う:
 *
 * - **baseline（保存済みの起点）**: より新しい保存が既に成功していたら、古い
 *   保存の成功で動かさない。これで baseline は「最後に発行された成功保存の
 *   内容」に収束し、到着順に依存しない。かつて到着順に素直に書いていた頃は、
 *   遅れて返った古い応答が baseline を巻き戻し、保存済みの文書が「未保存」と
 *   して蘇っていた。
 * - **display（ヘッダーの表示）**: 追い越された応答は何も言わない。成功でも
 *   失敗でも同じ。以前は失敗だけ無条件に「保存できませんでした」を出していた
 *   ので、2件が飛んでいて新しい方が成功・古い方が失敗すると、保存できている
 *   のに失敗表示が残っていた（逆順に返れば残らない＝到着順で見た目が変わる）。
 *
 * 2つを別々の連番で追うのは、片方だけが動く場合があるから: 新しい保存が失敗
 * したあとに古い保存の成功が届いたら、サーバーは確かにその内容を持っている
 * ので baseline は進めてよいが、「保存しました」と言ってはいけない（いま画面に
 * ある内容はまだ保存されていない）。
 *
 * fetch も timer も持たない純粋なデータなので、任意の発行・応答の交錯を
 * `saveTracker.property.test.ts` が総当たりできる。実際の fetch とデバウンス
 * タイマーは `components/useNoteEditor.ts` が持つ。
 */

/** 自動保存のデバウンス初期値（ms）。 */
export const AUTOSAVE_DELAY_MS = 1500;
/** 失敗時の指数バックオフの上限（ms）。 */
export const AUTOSAVE_MAX_DELAY_MS = 15000;

/**
 * 次の再試行までの待ち時間。失敗が続く間だけ倍々に伸び、上限で頭打ちになる
 * （成功するか文書が変わればデバウンスごと張り直され、`AUTOSAVE_DELAY_MS` に
 * 戻る）。
 */
export function nextRetryDelay(delay: number): number {
  return Math.min(delay * 2, AUTOSAVE_MAX_DELAY_MS);
}

export interface SaveTracker {
  /**
   * 保存済みと確認できている直列化内容。`null` は「追跡しない」——
   * 未保存ノート（noteId なし）と閲覧専用では保存系がまるごと動かないので、
   * 差分の概念自体が無い（{@link isDirty} は常に false）。
   */
  readonly baseline: string | null;
  /** これまでに発行した保存の総数（次に発行する保存の連番 - 1）。 */
  readonly issued: number;
  /** baseline を進めた最新の保存の連番。0 = まだ一件も成功していない。 */
  readonly acked: number;
  /**
   * 結末（成功・失敗どちらでも）を表示に反映した最新の保存の連番。これ以下の
   * 応答は追い越されているので、表示を動かす資格がない。
   */
  readonly settled: number;
}

/** 何も追跡しない初期状態（未保存ノート / 閲覧専用）。 */
export const untrackedSave: SaveTracker = { baseline: null, issued: 0, acked: 0, settled: 0 };

/** まだ追跡が始まっていないか（保存済みの起点を持たない）。 */
export function isUntracked(tracker: SaveTracker): boolean {
  return tracker.baseline === null;
}

/** サーバーから受け取った内容を保存済みの起点として追跡を始める。 */
export function initialSaveTracker(baseline: string): SaveTracker {
  return { baseline, issued: 0, acked: 0, settled: 0 };
}

/**
 * 保存を発行する。返った tracker の `issued` がこの保存の連番で、それを成功時に
 * {@link settleSave} へ渡すことで応答がどの保存のものか決まる。
 */
export function beginSave(tracker: SaveTracker): SaveTracker {
  return { ...tracker, issued: tracker.issued + 1 };
}

/** 保存 `seq` の結末。成功は保存できた内容を運ぶ。 */
export type SaveOutcome = { ok: true; content: string } | { ok: false };

/**
 * 応答を取り込んだ結果、ヘッダーに出すべき表示。`null` = 追い越された応答なので
 * 何も言わない（表示の文言はコンポーネント側の `SaveStatusText` と対）。
 */
export type SaveDisplay = "saved" | "save-failed" | null;

/**
 * 保存 `seq` の結末を取り込む。上のモジュールコメントの2つの規則をそのまま
 * 書いたもの。同じ応答を何度渡しても、発行済みでない `seq` を渡しても、
 * どちらの連番も追い越せないので結果は変わらない（冪等）。
 */
export function settleSave(
  tracker: SaveTracker,
  seq: number,
  outcome: SaveOutcome
): { tracker: SaveTracker; display: SaveDisplay } {
  // 成功なら、まだ誰にも追い越されていない限り baseline を進める。失敗が
  // 先に届いていても進めてよい: サーバーは確かにその内容を持っている。
  const advanced =
    outcome.ok && seq > tracker.acked
      ? { ...tracker, acked: seq, baseline: outcome.content }
      : tracker;
  if (seq <= tracker.settled) return { tracker: advanced, display: null };
  return {
    tracker: { ...advanced, settled: seq },
    display: outcome.ok ? "saved" : "save-failed",
  };
}

/** 保存が確認できていない編集があるか。追跡していなければ常に false。 */
export function isDirty(tracker: SaveTracker, content: string): boolean {
  return !isUntracked(tracker) && content !== tracker.baseline;
}
