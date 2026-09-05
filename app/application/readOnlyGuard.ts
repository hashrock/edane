/**
 * Application layer: 閲覧専用モードのアクション遮断。
 *
 * 閲覧専用は「編集UIを隠す」では守れない。canvas と outline の2ビューに加えて
 * キーマップ・コマンドパレット・コンテキストメニュー・DnD と dispatch の入口は
 * 多く、どれか一つの隠し忘れが編集を通してしまう。そこで**遮断は dispatch の
 * 一点だけ**で行い、経路の数に依存しない形にしてある。
 *
 * ここはその一点を純粋関数として切り出したもの。`readOnly` のとき
 * {@link guardedStep} が返す状態は、
 *
 *   - 決して編集モードにならない（`view.editing` は false のまま）、かつ
 *   - `toggleCollapse` 以外では文書（モデル）を変えない
 *
 * ——という2つの不変条件を、アクションの種類や順序によらず満たす。折りたたみ
 * だけ通すのは閲覧操作だからで、保存系は閲覧専用で全部止まっているため
 * 永続化はされない。任意のアクション列に対する総当たりは
 * `readOnlyGuard.property.test.ts`。
 */

import type { IdSource } from "../domain/model";
import { editorReducer, type EditorAction, type EditorState } from "./editorReducer";

/**
 * reducer を1手進める。`readOnly` のときは編集につながる結果を捨てて `prev` を
 * そのまま返す（呼び出し側は同一参照を「何も起きなかった」として扱える）。
 */
export function guardedStep(
  prev: EditorState,
  action: EditorAction,
  readOnly: boolean,
  nextId?: IdSource
): EditorState {
  // クリックによる選択は活かしたいので、activateNode は編集突入だけ剥がす。
  const guarded =
    readOnly && action.type === "activateNode" && action.editing
      ? { ...action, editing: false }
      : action;
  const next = editorReducer(prev, guarded, nextId);
  if (next === prev || !readOnly) return next;
  // 編集モードに入る遷移は捨てる（startEditing / dragSelect など）。
  if (next.view.editing) return prev;
  // モデルを変えるアクションも捨てる。折りたたみだけは「読むための操作」として
  // 通す（保存系は閲覧専用で全部止まっているので永続化はされない）。
  if (next.document.model !== prev.document.model && guarded.type !== "toggleCollapse") {
    return prev;
  }
  return next;
}
