# CLAUDE.md

## キーボード不変条件（keyboard-escape invariant）— 絶対に守ること

**編集フォーカスがどのDOM要素にあっても、修飾キーなしの矢印キーは「ノード内のカーソル移動」か「隣のノードへの移動」を必ず起こす。イベントが何もせずネイティブ処理に落ちて、キーボードが入力欄に閉じ込められることを禁止する。**

- **↑ / ↓**: ノード内の行を移動し、先頭行/末尾行からは前/次のノードへ抜ける。単一行フィールドには移動する行がないので常にノード移動になる。
- **← / →**: ノード内の文字を移動し、カーソルが先頭/末尾の端にあれば前/次のノードへ抜ける。

これはどのノード種別（`NodeType`）でも、どのレイアウト（canvas = MindmapEditor / outline = OutlineEditor）でも成立しなければならない。

← / → は `arrowBehavior` 設定（`app/application/editorPreferences.ts`）の2値どちらでも成立する。この設定が切り替えるのは**選択モード**の ← / →（折りたたみ or 親子移動）だけで、不変条件が対象とする**編集モード**では ← / → はどちらの設定でもカーソルキーだから。

↑ / ↓ も同じ理由で、**選択モードだけがレイアウトで変わる**。canvasの選択モードでは兄弟間の移動（`moveToPrevSibling` / `moveToNextSibling`）で端では止まる（階層をまたぐのは ← / → の仕事）が、不変条件が対象とする**編集モード**では canvas / outline とも `moveUp` / `moveDown`＝フラット順で必ず隣のノードへ抜ける。**選択モードの ↑ / ↓ に「移動先がなければ止まる」挙動を足すのは構わないが、編集モードの ↑ / ↓ を止めてはいけない**（キャレットが閉じ込められる）。

### 守り方

- 編集面の宣言は `app/application/editSurface.ts` の `EDIT_SURFACE` テーブル（layout × NodeType、`satisfies` で網羅強制）。**`NodeType` を追加するとここがコンパイルエラーになるので、必ず編集面の種類を宣言する。**
  - `keymap-textarea`: 共有textarea（keymap経由）。`app/application/editorKeymap.ts` の edit-up / edit-down / edit-left / edit-right が不変条件を保証する。追加作業なし。
  - `aux-input`: ノード専用のinput（URL欄など）。**onKeyDown で必ず `handleAuxInputKeys(e, dispatch)` を最初に呼ぶこと。** Enter/Escape=編集終了、修飾なし↑↓=ノード移動、修飾なし←→=端でノード移動（それ以外はネイティブのカーソル移動）を一括処理する。自前で Enter/Escape だけ処理するのは禁止（閉じ込めバグの典型パターン）。
  - `modal-panel`: サイドパネル編集（canvasのmarkdown）。パネルは開いてもキーボードを奪わず、エディタは選択モードに戻る。パネル内のEscapeで閉じる。テキストフィールドがキーボードを持たないので、← / → の不変条件はこの面だけ対象外（選択モードのバインドが効く）。
- 実挙動の検証は `app/components/keyboardEscape.browser.test.tsx`。NodeType × レイアウト × 方向を総当たりし、編集中に規定回数以内の矢印キーで隣ノードへ到達することをフォーカス位置に依存せず検証する。**`NodeType` を追加するとフィクスチャの `TARGETS` もコンパイルエラーになるので、必ずフィクスチャを追加する。** 実行: `pnpm vitest run --project browser app/components/keyboardEscape.browser.test.tsx`

### テスト

- 単体・ロジック: `pnpm test`（node project）
- ブラウザe2e: `pnpm test:e2e`（chromium; `*.browser.test.tsx`）
