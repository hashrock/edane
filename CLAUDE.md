# CLAUDE.md

## キーボード不変条件（keyboard-escape invariant）— 絶対に守ること

**編集フォーカスがどのDOM要素にあっても、修飾キーなしの矢印キーは「ノード内のカーソル移動」か「隣のノードへの移動」を必ず起こす。イベントが何もせずネイティブ処理に落ちて、キーボードが入力欄に閉じ込められることを禁止する。**

- **↑ / ↓**: ノード内の行を移動し、先頭行/末尾行からは前/次のノードへ抜ける。単一行フィールドには移動する行がないので常にノード移動になる。
- **← / →**: ノード内の文字を移動し、カーソルが先頭/末尾の端にあれば前/次のノードへ抜ける。

これはどのノード種別（`NodeType`）でも、どのレイアウト（canvas = MindmapEditor / outline = OutlineEditor）でも成立しなければならない。

← / → は `arrowBehavior` 設定（`app/application/editorPreferences.ts`）の2値どちらでも成立する。この設定が切り替えるのは**選択モード**の ← / →（折りたたみ or 親子移動）だけで、不変条件が対象とする**編集モード**では ← / → はどちらの設定でもカーソルキーだから。

↑ / ↓ も同じ理由で、**選択モードだけがレイアウトで変わる**。canvasの選択モードは `moveUpSiblingFirst` / `moveDownSiblingFirst`＝兄弟を辿り、尽きたら枝の外へ出る（↑は親へ、↓はサブツリーを飛び越えて次のノードへ）。**子には決して降りない — 階層を降りるのは → の仕事**。不変条件が対象とする**編集モード**では canvas / outline とも `moveUp` / `moveDown`＝フラット順。

**↑ / ↓ が行き止まりになってはいけない**（編集モードならキャレットの閉じ込め、選択モードなら枝の末尾で操作不能）。ただし選択モードでは「移動先が木構造から決まる」ことのほうが優先で、**同じ操作の意味が木の位置や過去の操作履歴によって変わってはいけない**。canvasの↓が止まるのは木の末尾側の縁（最後のトップレベルノード → その最後の子 → そのまた最後の子…）だけで、そこは → で子に入る。↑が止まるのは最初のトップレベルノードだけ。

かつて↓のフォールバックをフラット順の隣にしていたときは、「自分が親の最後の子か」というユーザーに見えない条件で↓が子に降りたり降りなかったりしていた。**行き止まりを避けるためにフォールバックや記憶を足すときは、その移動先が木のどこでも同じ規則で決まるか確かめること。**

### ルートは「ノード」ではない（invisible root）

`MindMapModel` のルートはノートのタイトルであり、canvas にも outline にも描かれず、選択・編集・ナビゲーションの対象にならない。ルートの子（トップレベルノード）がそれぞれ独立した木として並ぶ「マルチルート」の見た目になる。

- 可視/ナビゲーション対象の集合を作る走査（`getFlatOrder` / `flattenToNodes` / `outlineRows`）はすべて `topLevelNodes(model)` から始める。ルートから始める走査を新たに書かないこと。
- 「他にフォーカス先がない」フォールバックは `firstNavigableId(model)`（最初のトップレベルノード）。`model.id` にフォールバックしてはいけない（不可視ノードがアクティブになる）。
- ドキュメントは常にトップレベルノードを1つ以上持つ。`parseContent` と `editorReducer` が `ensureTopLevelNode` で保証する。
- canvas ではトップレベルノード（`MindMapNode.depth === 0`）が旧ルートの見た目（濃色・最小幅100）を引き継ぐ。`nodes[0]` をルート扱いするコードを書かないこと。
- ドラッグ&ドロップでトップレベルノードの親は `model.id`（`DropRoot`）として扱う。
- **木（ルート）は意図してしか作れない**。作る手段は空きキャンバスの右クリック →「ここにルートを追加」（`addRootAt`）だけ。トップレベルノードに対する「兄弟を作る」操作（Enter・分割・ペースト・`insertSiblingAfter`・DnD の兄弟ゾーン）はすべて「子を作る」に読み替える（`isTopLevel` で分岐。旧単一ルートと同じ扱い）。ネストしたノードを空き領域にドロップしても木にはならない（no-drop）。
- 各木は canvas 上に自由配置できる。`MindMapModel.position`（トップレベルノードのみ有効、箱の左端x・縦中央y）を `treeLayout` が優先し、未配置の木は配置済みの木の縦の帯を避けて自動で縦に積む。トップレベルノードを空き領域にドロップすると `placeBranchAt` でそこに固定（ドメイン関数自体はネストノードの切り出しもできるが、UI からは呼ばない）。自分のサブツリー上で離した場合はキャンセル。`moveBranch` でネストされると `position` は捨てる。

### 守り方

- 編集面の宣言は `app/application/editSurface.ts` の `EDIT_SURFACE` テーブル（layout × NodeType、`satisfies` で網羅強制）。**`NodeType` を追加するとここがコンパイルエラーになるので、必ず編集面の種類を宣言する。**
  - `keymap-textarea`: 共有textarea（keymap経由）。`app/application/editorKeymap.ts` の edit-up / edit-down / edit-left / edit-right が不変条件を保証する。追加作業なし。
  - `aux-input`: ノード専用のinput（URL欄など）。**onKeyDown で必ず `handleAuxInputKeys(e, dispatch)` を最初に呼ぶこと。** Enter/Escape=編集終了、修飾なし↑↓=ノード移動、修飾なし←→=端でノード移動（それ以外はネイティブのカーソル移動）を一括処理する。自前で Enter/Escape だけ処理するのは禁止（閉じ込めバグの典型パターン）。
  - `modal-panel`: サイドパネル編集（canvasのmarkdown）。パネルは開いてもキーボードを奪わず、エディタは選択モードに戻る。パネル内のEscapeで閉じる。テキストフィールドがキーボードを持たないので、← / → の不変条件はこの面だけ対象外（選択モードのバインドが効く）。
- keymap は純粋（`buildKeymap(prefs, layout, verticalMove)` → `runKeymap` が `KeyEffect[]` を返すだけ）。副作用は `app/components/applyKeyEffects.ts` が実行する。複数手順の操作（貼り付け）は `app/application/editorCommands.ts` が同じ `KeyEffect[]`（dispatch 列 + flash + save）として返し、同じ `applyKeyEffects` が実行する。コンポーネントに dispatch の列を直書きしないこと（列がテストから見えなくなる）。
- 不変条件の node での総当たりは `app/application/editorKeymap.property.test.ts`（任意の木 × キャレット位置 × 方向 × layout × arrowBehavior）。
- 実挙動の検証は `app/components/keyboardEscape.browser.test.tsx`。NodeType × レイアウト × 方向を総当たりし、編集中に規定回数以内の矢印キーで隣ノードへ到達することをフォーカス位置に依存せず検証する。**`NodeType` を追加するとフィクスチャの `TARGETS` もコンパイルエラーになるので、必ずフィクスチャを追加する。** 実行: `pnpm vitest run --project browser app/components/keyboardEscape.browser.test.tsx`

### テスト

- 単体・ロジック: `pnpm test`（node project）
- プロパティベース（fast-check）: `*.property.test.ts`。`MindMapModel` の生成器は `app/domain/model.arb.ts`（ID一意・トップレベル≥1・`position` はトップレベルのみ、を構成で保証）。ドメイン操作の契約・reducer のフォーカス不変条件・シリアライズ往復・レイアウトの非重複はここで総当たりする。
- ブラウザe2e: `pnpm test:e2e`（chromium; `*.browser.test.tsx`）
