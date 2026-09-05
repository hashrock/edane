/**
 * Application layer: autosave bookkeeping as a pure state machine.
 *
 * 保存は非同期で、編集中に前の保存がまだ飛んでいることがある。つまり複数の
 * 保存が同時に走り、**応答は発行順に返るとは限らない**。「どこまで保存済みか」
 * （= baseline）をこの順序ゆらぎの中で正しく保つのが、この状態機械の唯一の
 * 仕事である。
 *
 * 規則はひとつだけ: **より新しい保存が既に成功していたら、古い保存の成功で
 * baseline を動かさない**。これにより baseline は「最後に発行された成功保存の
 * 内容」に収束し、応答の到着順に依存しない（= 順序非依存）。かつて到着順に
 * 素直に baseline を書いていた頃は、遅れて返った古い応答が baseline を巻き
 * 戻し、保存済みの文書が「未保存」として蘇っていた。
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
}

/** 何も追跡しない初期状態（未保存ノート / 閲覧専用）。 */
export const untrackedSave: SaveTracker = { baseline: null, issued: 0, acked: 0 };

/** まだ追跡が始まっていないか（保存済みの起点を持たない）。 */
export function isUntracked(tracker: SaveTracker): boolean {
  return tracker.baseline === null;
}

/** サーバーから受け取った内容を保存済みの起点として追跡を始める。 */
export function initialSaveTracker(baseline: string): SaveTracker {
  return { baseline, issued: 0, acked: 0 };
}

/**
 * 保存を発行する。返った tracker の `issued` がこの保存の連番で、それを成功時に
 * {@link acknowledgeSave} へ渡すことで応答がどの保存のものか決まる。
 */
export function beginSave(tracker: SaveTracker): SaveTracker {
  return { ...tracker, issued: tracker.issued + 1 };
}

/**
 * 保存 `seq` の成功を取り込む。`accepted` は「これが今までで最新の成功応答
 * だったか」——false のときは古い応答が遅れて返っただけなので baseline も
 * 「保存しました」表示も動かさない。
 *
 * 失敗応答は何も変えない（この関数を呼ばない）。発行済みでない `seq`（重複
 * 配送を含む）も `acked` 以下なので自然に弾かれ、同じ応答を何度渡しても
 * 結果は変わらない。
 */
export function acknowledgeSave(
  tracker: SaveTracker,
  seq: number,
  content: string
): { tracker: SaveTracker; accepted: boolean } {
  if (seq <= tracker.acked) return { tracker, accepted: false };
  return { tracker: { ...tracker, acked: seq, baseline: content }, accepted: true };
}

/** 保存が確認できていない編集があるか。追跡していなければ常に false。 */
export function isDirty(tracker: SaveTracker, content: string): boolean {
  return !isUntracked(tracker) && content !== tracker.baseline;
}
