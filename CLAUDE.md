# CLAUDE.md

## キーボード不変条件（keyboard-escape invariant）— 絶対に守ること

**編集フォーカスがどのDOM要素にあっても、修飾キーなしの矢印キーは「ノード内のカーソル移動」か「隣のノードへの移動」を必ず起こす。イベントが何もせずネイティブ処理に落ちて、キーボードが入力欄に閉じ込められることを禁止する。**

- **↑ / ↓**: ノード内の行を移動し、先頭行/末尾行からは前/次のノードへ抜ける。単一行フィールドには移動する行がないので常にノード移動になる。
- **← / →**: ノード内の文字を移動し、カーソルが先頭/末尾の端にあれば前/次のノードへ抜ける。

これはどのノード種別（`NodeType`）でも、どのレイアウト（canvas = MindmapEditor / outline = OutlineEditor）でも成立しなければならない。

← / → は `arrowBehavior` 設定（`app/application/editorPreferences.ts`）の2値どちらでも成立する。この設定が切り替えるのは**選択モード**の ← / →（折りたたみ or 親子移動）だけで、不変条件が対象とする**編集モード**では ← / → はどちらの設定でもカーソルキーだから。

↑ / ↓ も同じ理由で、**選択モードだけがレイアウトで変わる**。canvasの選択モードは `moveUpSiblingFirst` / `moveDownSiblingFirst`＝兄弟を辿り、尽きたら枝の外へ出る（↑は親へ、↓はサブツリーを飛び越えて次のノードへ）。**子には決して降りない — 階層を降りるのは → の仕事**。不変条件が対象とする**編集モード**では canvas / outline とも `moveUp` / `moveDown`＝フラット順。

**↑ / ↓ が行き止まりになってはいけない**（編集モードならキャレットの閉じ込め、選択モードなら枝の末尾で操作不能）。ただし選択モードでは「移動先が木構造から決まる」ことのほうが優先で、**同じ操作の意味が木の位置や過去の操作履歴によって変わってはいけない**。canvasの↓が止まるのはドキュメントの末尾側の縁（最後のルート → その最後の子 → そのまた最後の子…）だけで、そこは → で子に入る。↑が止まるのは最初のルートだけ。

かつて↓のフォールバックをフラット順の隣にしていたときは、「自分が親の最後の子か」というユーザーに見えない条件で↓が子に降りたり降りなかったりしていた。**行き止まりを避けるためにフォールバックや記憶を足すときは、その移動先が木のどこでも同じ規則で決まるか確かめること。**

### ドキュメントはルートの配列（multi-root）

`MindMapDocument`（`app/domain/model.ts`）は `{ title, roots }`。`title` はノートのタイトルでノードではない（ヘッダーで編集し、`notes.title` 列に保存する）。`roots` は木の配列で、各ルート（`MindMapModel`）が canvas / outline に独立した木として並ぶ。**「見えないルートノード」は存在しない**。ノードを探す・位置を知るときは `findNode(doc, id)` / `locateNode(doc, id)`（`parent === null` ならルート、`siblings` は `doc.roots` か `parent.children`）を使い、`parent.id === model.id` のような比較を書かないこと。

- 可視/ナビゲーション対象の集合を作る走査（`getFlatOrder` / `flattenToNodes` / `outlineRows`）はすべて `doc.roots` から始める。
- 「他にフォーカス先がない」フォールバックは `firstRootId(doc)`。
- ドキュメントは常にルートを1つ以上持つ。`parseContent` と `editorReducer` が `ensureRoot` で保証する（最後のルートを削除・カットすると空のルートに置き換わり、それがフォーカスを取る）。
- canvas ではルート（`MindMapNode.depth === 0`）が濃色・最小幅100の見た目になる。`nodes[0]` をルート扱いするコードを書かないこと。
- **木（ルート）は意図してしか作れない**。作る手段は、空きキャンバスの右クリック →「ここに新しいツリーを追加」（`addRootAt`）、ルート直下の子の Shift+Tab（`dedentNode`）、ノードの右クリック →「枝を切り離して新しいツリーに」（`placeBranchAt`。ルートには出さないので、木が生えるのはネストした枝からだけ。枝は今のレイアウト位置に置くので箱は動かず、穴の空いた元の木の方が組み直される）、ルートの自由配置（同じく `placeBranchAt`）。ルートに対する「兄弟を作る」操作（Enter・分割・ペースト・`insertSiblingAfter`・DnD の兄弟ゾーン）はすべて「子を作る」に読み替える（`addSiblingAfter` / `splitNode` / `insertNodes` が `locateNode` の `parent === null` で分岐。旧単一ルートと同じ扱い）。ネストしたノードを空き領域にドロップしても木にはならない（no-drop）。
- ルート同士は `doc.roots` 上の兄弟。選択モードの ↑↓（`moveUpSiblingFirst` / `moveDownSiblingFirst`）はルート間を順に辿り、Alt+↑↓（`moveNodeUp` / `moveNodeDown`）はルートの順序を入れ替え、Backspace/Delete の連結（`mergeIntoPredecessor` / `mergeSuccessorInto`）は隣のルートと木を結合する。
- 各木は canvas 上に自由配置できる。`MindMapModel.position`（ルートのみ有効、箱の左端x・縦中央y）を `treeLayout` が優先し、未配置の木は `startX` の1列に上から自動で縦に積む（**配置済みの木は避けない** — 重なりうる。避けさせると木をドロップした・1行増えただけで無関係な木が飛ぶので、重なりはユーザーがドラッグで直す方を選んだ）。ルートを空き領域にドロップすると `placeBranchAt` でそこに固定。自分のサブツリー上で離した場合はキャンセル。ノードをネストする経路（作成・分割・indent・ペースト・DnD）はすべて `nestUnder` を通り、そこで親を展開し `position` を捨てる。

### 保存形式とマイグレーション

`content` 列の JSON は **v2 `{ "version": 2, "roots": [...] }`**（`serializeDocument`）。タイトルは content に含めず、保存 API の `title` フィールド（`notes.title` 列）で運ぶ。`parseContent(content, title)` は v2 / v1（旧: ルートノード1個 `{ id, text, children }`）/ 旧インデントテキストの3形式を読み、必ず `MindMapDocument` を返す。**旧形式は単一ルートとして移行する**: v1 のルートノードは id・サブツリーごと `roots[0]` になり（#135 で一時的に「子＝別々の木」として表示していたものも、元の1本の木に戻る）、テキスト形式はタイトルを持つルート1個の下に行を並べる。木が複数になるのはユーザーがルートを追加したときだけ。**書き込みは常に v2** なので、開いて保存した時点でそのノートは移行される（暗号化された行を SQL で書き換える必要はない）。詳細は `docs/adr/0002-multi-root-document.md`。

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
- プロパティベース（fast-check）: `*.property.test.ts`。`MindMapDocument` の生成器は `app/domain/model.arb.ts`（ID一意・ルート≥1・`position` はルートのみ、を構成で保証）。ドメイン操作の契約・reducer のフォーカス不変条件・シリアライズ往復・レイアウトの非重複はここで総当たりする。ランダムな `EditorAction` 列の生成器は `app/application/editorState.arb.ts` の `actionStepArb` / `resolveStep`（全変種を `satisfies` で網羅強制）。同じアクション列で駆動される状態機械（reducer・閲覧専用ガード）は必ずこれを共有すること。
- ブラウザe2e: `pnpm test:e2e`（chromium; `*.browser.test.tsx`）
