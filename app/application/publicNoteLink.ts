/**
 * 公開ノートの共有リンク（`/notes/:id`）まわりの決めごと。
 *
 * エディタ（MindmapEditor / OutlineEditor のヘッダー）とノート一覧のメニューの
 * 両方から同じURL・同じ文言を使うため、UIに依存しない純関数と定数をここに置く。
 */

import { t } from "./i18n";

/**
 * 非公開ノートでコピー動線を無効化するときに添える理由（現在言語で解決）。
 *
 * 「非公開なら項目ごと消す」ではなく「出したまま無効化して理由を見せる」を選んだ:
 * 消してしまうと "この機能が無い" のか "このノートだから出せない" のかが区別
 * できず、公開に切り替えれば共有できることに気づけない。エディタでは同じメニュー
 * （PublicityDropdown）に公開切り替えが並んでいるので、理由を見せれば次の操作へ
 * そのまま繋がる。
 *
 * 定数ではなく関数なのは言語切り替えに追従するため（呼び出し時に解決する）。
 */
export function privateNoteCopyReason(): string {
  return t("privateNoteCopyReason");
}

/** コピー成功時のフィードバック文言。 */
export function copyLinkSuccess(): string {
  return t("copyLinkSuccess");
}

/** コピー失敗時（クリップボードが使えない環境）のフィードバック文言。 */
export function copyLinkFailure(): string {
  return t("copyLinkFailure");
}

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
