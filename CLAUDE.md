# CLAUDE.md

## キーボード不変条件（keyboard-escape invariant）— 絶対に守ること

**編集フォーカスがどのDOM要素にあっても、修飾キーなしの ↑ / ↓ は「ノード内の行移動」か「隣のノードへの移動」を必ず起こす。イベントが何もせずネイティブ処理に落ちて、キーボードが入力欄に閉じ込められることを禁止する。単一行フィールドでは ↑ / ↓ は常にノード移動になる。**

これはどのノード種別（`NodeType`）でも、どのレイアウト（canvas = MindmapEditor / outline = OutlineEditor）でも成立しなければならない。

### 守り方

- 編集面の宣言は `app/application/editSurface.ts` の `EDIT_SURFACE` テーブル（layout × NodeType、`satisfies` で網羅強制）。**`NodeType` を追加するとここがコンパイルエラーになるので、必ず編集面の種類を宣言する。**
  - `keymap-textarea`: 共有textarea（keymap経由）。`app/application/editorKeymap.ts` の edit-up / edit-down が不変条件を保証する。追加作業なし。
  - `aux-input`: ノード専用のinput（URL欄など）。**onKeyDown で必ず `handleAuxInputKeys(e, dispatch)` を最初に呼ぶこと。** Enter/Escape=編集終了、修飾なし↑↓=ノード移動を一括処理する。自前で Enter/Escape だけ処理するのは禁止（↑↓の閉じ込めバグの典型パターン）。
  - `modal-panel`: サイドパネル編集（canvasのmarkdown）。パネルは開いてもキーボードを奪わず、エディタは選択モードに戻る。パネル内のEscapeで閉じる。
- 実挙動の検証は `app/components/keyboardEscape.browser.test.tsx`。NodeType × レイアウトを総当たりし、編集中に規定回数以内の ↑ / ↓ で隣ノードへ到達することをフォーカス位置に依存せず検証する。**`NodeType` を追加するとフィクスチャの `TARGETS` もコンパイルエラーになるので、必ずフィクスチャを追加する。** 実行: `pnpm vitest run --project browser app/components/keyboardEscape.browser.test.tsx`

### テスト

- 単体・ロジック: `pnpm test`（node project）
- ブラウザe2e: `pnpm test:e2e`（chromium; `*.browser.test.tsx`）
