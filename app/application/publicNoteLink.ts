/**
 * 公開ノートの共有リンク（`/notes/:id`）まわりの決めごと。
 *
 * エディタ（MindmapEditor / OutlineEditor のヘッダー）とノート一覧のメニューの
 * 両方から同じURL・同じ文言を使うため、UIに依存しない純関数と定数をここに置く。
 */

/**
 * 非公開ノートでコピー動線を無効化するときに添える理由。
 *
 * 「非公開なら項目ごと消す」ではなく「出したまま無効化して理由を見せる」を選んだ:
 * 消してしまうと "この機能が無い" のか "このノートだから出せない" のかが区別
 * できず、公開に切り替えれば共有できることに気づけない。エディタでは同じメニュー
 * （PublicityDropdown）に公開切り替えが並んでいるので、理由を見せれば次の操作へ
 * そのまま繋がる。
 */
export const PRIVATE_NOTE_COPY_REASON = "非公開のため共有できません";

/** コピー成功時のフィードバック文言。 */
export const COPY_LINK_SUCCESS = "リンクをコピーしました";

/** コピー失敗時（クリップボードが使えない環境）のフィードバック文言。 */
export const COPY_LINK_FAILURE = "コピーできませんでした";

/**
 * 公開ノートの閲覧URL（絶対URL）。
 *
 * @param origin `window.location.origin` 相当。末尾スラッシュ付きを渡されても
 *   二重スラッシュにはしない。
 * @param noteId ノートID。
 */
export function publicNoteUrl(origin: string, noteId: string): string {
  return `${origin.replace(/\/+$/, "")}/notes/${encodeURIComponent(noteId)}`;
}
