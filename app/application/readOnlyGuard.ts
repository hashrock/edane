/**
 * Application layer: 閲覧専用モードのアクション遮断。
 *
 * 閲覧専用は「編集UIを隠す」では守れない。canvas と outline の2ビューに加えて
 * キーマップ・コマンドパレット・コンテキストメニュー・DnD と dispatch の入口は
 * 多く、どれか一つの隠し忘れが編集を通してしまう。そこで**遮断は dispatch の
 * 一点だけ**で行い、経路の数に依存しない形にしてある。
 *
 * 判定は2段構えで、**それぞれ違う壊れ方を捕まえる**:
 *
 * - {@link READ_ONLY_ALLOWED} は `satisfies` で網羅を強制するので、**新しい
 *   `EditorAction`** を足すと可否を決めるまでコンパイルが通らない（`EDIT_SURFACE`
 *   が `NodeType` に対してやっているのと同じ）。以前は reducer の結果だけで
 *   判定していたので、新しいアクションは黙って通る側に倒れていた。
 * - 結果の検査は、**既にある許可済みアクション**が編集能力を得てしまった場合を
 *   捕まえる。型では表せないので、宣言が間違っていても不変条件は構造的に守られる。
 *
 * `readOnlyGuard.property.test.ts` は「許可したアクションでは結果の検査が一度も
 * 発動しない」＝宣言が正直であることまで確かめるので、2つが食い違えば落ちる。
 *
 * `readOnly` のとき {@link guardedStep} が返す状態は、アクションの種類や順序に
 * よらず「編集モードにならない」「`toggleCollapse` 以外でモデルを変えない」。
 */

import { isKeyOf } from "../domain/isKeyOf";
import type { IdSource } from "../domain/model";
import { editorReducer, type EditorAction, type EditorState } from "./editorReducer";

/**
 * 閲覧専用で通してよいアクション。true = 読む操作。
 *
 * 判定の基準はひとつ: **文書を変えず、編集モードにも入らないか**。カーソルや
 * 選択範囲だけを動かすものは、閲覧専用では編集中にならないので画面には出ないが、
 * 「読む操作」であることに変わりはないので通す。
 */
const READ_ONLY_ALLOWED = {
  // --- 移動: 選択とキャレットを動かすだけ ---
  moveUp: true,
  moveDown: true,
  moveUpSiblingFirst: true,
  moveDownSiblingFirst: true,
  moveToParent: true,
  moveToChild: true,
  arrowLeftEdge: true,
  arrowRightEdge: true,
  cmdLeft: true,
  cmdRight: true,
  cmdShiftLeft: true,
  cmdShiftRight: true,
  setSelection: true,
  // クリックによる選択。`editing: true` で来たら下で剥がす。
  activateNode: true,
  // 編集モードから出るだけ——入ることはない（閲覧専用ではそもそも編集中に
  // ならないので実質 no-op）。
  exitEditing: true,
  // 折りたたみは「読むための操作」。閲覧専用が唯一モデルを変えてよい経路で、
  // 保存系は全部止まっているので永続化はされない。
  toggleCollapse: true,
  // コピーは読む操作。クリップボードは文書の一部だが、木は変わらない。
  copyBranch: true,

  // --- 編集モードに入る / 編集バッファを書く ---
  startEditing: false,
  // 範囲選択は編集ジェスチャ（どちらも `editing: true` を立てる）。
  selectAllInNode: false,
  dragSelect: false,
  // IME 変換中はモデルを変えないが、編集バッファを書く操作。
  typeText: false,

  // --- 文書を変える ---
  enter: false,
  tab: false,
  backspaceAtStart: false,
  deleteAtEnd: false,
  moveNodeUp: false,
  moveNodeDown: false,
  moveBranch: false,
  placeBranchAt: false,
  addRootAt: false,
  insertSiblingAfter: false,
  addChild: false,
  deleteNode: false,
  cutBranch: false,
  pasteBranch: false,
  setNodeType: false,
  setNodeContent: false,
  setNodeStyle: false,
  setLinkMeta: false,
  setChecked: false,
  insertNodes: false,
  setTitle: false,
  // undo/redo の文書丸ごと差し替え。閲覧専用では undo スタックに何も積まれない
  // ので実際には来ないが、通す理由もない。
  replace: false,
} as const satisfies Record<EditorAction["type"], boolean>;

/**
 * 閲覧専用で通してよいアクションか。`isKeyOf` を通すのは fail-closed のため——
 * 素の添字だと `"constructor"` が `Object.prototype` の関数に当たって truthy に
 * なり、遮断すべきものを通してしまう。
 */
export function isReadOnlyAllowed(type: string): boolean {
  return isKeyOf(READ_ONLY_ALLOWED, type) && READ_ONLY_ALLOWED[type];
}

/**
 * reducer を1手進める。`readOnly` のときは編集につながるアクションとその結果を
 * 捨てて `prev` をそのまま返す（呼び出し側は同一参照を「何も起きなかった」
 * として扱える）。
 */
export function guardedStep(
  prev: EditorState,
  action: EditorAction,
  readOnly: boolean,
  nextId?: IdSource
): EditorState {
  if (!readOnly) return editorReducer(prev, action, nextId);
  // 1. 宣言で弾く。
  if (!isReadOnlyAllowed(action.type)) return prev;
  // クリックによる選択は活かしたいので、activateNode は編集突入だけ剥がす。
  const guarded =
    action.type === "activateNode" && action.editing
      ? { ...action, editing: false }
      : action;
  const next = editorReducer(prev, guarded, nextId);
  if (next === prev) return next;
  // 2. 結果でも保証する（宣言が間違っていても不変条件は守られる）。
  if (next.view.editing) return prev;
  if (next.document.model !== prev.document.model && guarded.type !== "toggleCollapse") {
    return prev;
  }
  return next;
}
