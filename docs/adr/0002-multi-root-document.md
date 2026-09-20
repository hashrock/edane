# ADR 0002: ドキュメントを「ルートの配列」として正式に持つ（content v2）

- ステータス: Accepted
- 日付: 2026-09-20
- 対象コード: `app/domain/model.ts`, `app/application/persistence.ts`, `app/application/editorReducer.ts`

## コンテキスト

#135 でマルチルート（複数の木をキャンバスに並べる）を導入したとき、保存形式と `MindMapModel` の形は変えず、**単一ルートノードの `text` をノートのタイトル、`children` を「トップレベルノード＝各木のルート」と読み替え、そのルートノードを描画・選択・ナビゲーションから隠す**（invisible root）方法を採った。

この読み替えは動くが、コードの至るところで「本当はノードではないもの」を特別扱いする必要があった。

- `findParentAndIndex` がトップレベルノードの親として不可視ルートを返すので、呼び出し側が毎回 `parent.id === model.id` で「親はいないものとして扱う」分岐を書く。
- `model.id === nodeId` の「ルートは触らない」ガードがドメイン関数・reducer に散在し、しかもルートは選択できないので到達不能なコードになっていた。
- タイトルが content JSON（ルートの `text`）と `notes.title` 列の両方にあり、読み込み時は JSON 側が勝つため、API でタイトルだけ更新すると食い違う。
- `nodePathTexts` の先頭がタイトルになる、`getNodeDepths` のルートが 0 で `flattenToNodes` のトップレベルが 0、`DropRoot` という DnD 専用の擬似親、など「ルートがノードである」前提と「ルートは見えない」前提が混ざっていた。
- `dedentNode` がトップレベルノードの子を不可視ルート直下へ移す＝副作用として木が生えるが、それが意図した規則なのか読み替えの漏れなのか区別がつかなかった。

## 決定

1. **ドメインに `MindMapDocument = { title: string; roots: MindMapModel[] }` を導入する。** ルートノードという概念は廃止し、`roots` の各要素がそのまま木のルート。`MindMapModel` はノードだけを表す。
2. **ノードの位置は `locateNode(doc, id)` → `{ parent: MindMapModel | null; siblings; index }` で表す。** `parent === null` がルート、`siblings` は `doc.roots` か `parent.children`。ドメインの全操作をこの上に書き直し、「ルートは触らない」ガードを撤去する（ルートも削除・カット・並べ替え・結合できる。ただし最後のルートを消すと `ensureRoot` が空のルートを補う）。
3. **タイトルは content に含めない。** `MindMapDocument.title` は `notes.title` 列と `PUT /api/notes/:id` の `title` フィールドで運び、`parseContent(content, title)` が結合する。未保存判定（`isDirty`）は title + content のスナップショットで行う。
4. **保存形式を v2 `{ "version": 2, "roots": [...] }` にする。** 読み込みは v2 / v1 / 旧インデントテキストを受け付け、書き込みは常に v2。**旧形式は単一ルートとして移行する**: v1 のルートノードは id とサブツリーを保ったまま `roots[0]` になる（ルートを指す node publication もそのまま解決する。`text` はタイトル引数が無いときだけタイトルに採用）。旧インデントテキストはタイトルを持つルート1個の下に行を並べる。#135 は v1 の `children` を別々の木として見せていたが、これはユーザーが書いた形ではないので採らない。移行は「開いて保存した時点」に遅延させ、DB の一括書き換えは行わない（非公開ノートの content は暗号化されており SQL では書き換えられない。また v1 を読める限り未保存の行が残っても害はない）。
5. **UX の規則は変えない。** ルートに対する Enter / 分割 / ペーストは子を作る（旧単一ルートと同じ）、木を新たに作るのは「ここにルートを追加」・ルート直下の Shift+Tab・ルートの自由配置ドロップだけ、ネストしたノードの空き領域ドロップは no-drop。これらは `isRoot` / `locateNode` の `parent === null` で明示的に分岐する。

## 影響

- `findNode(doc, id)` はドキュメント全体を探す。サブツリー内だけ探すときは `findInTree(node, id)`。
- `detachBranch` / `splitNode` / `mergeIntoPredecessor` の戻り値のキーは `model` → `doc`。
- `serializeModel` → `serializeDocument`、`createDefaultModel` → `createDefaultDocument`、`textToModel` → `textToDocument` / `textToNodes`、`modelToText`（ノード単位）に加えて `documentToText`。
- `nodePathTexts(doc, id)` はノートのタイトルを含まない（設定ページは `noteTitle` を別途持っている）。
- `resolveDropTarget` から `DropRoot` 引数を撤去。ルートは `parentOf` に載らない。
- ~~#149 のノートごとの表示設定 `multiRoot`（ルートノードの属性だった）は `MindMapDocument.multiRoot` に移し、v2 JSON には `false` のときだけ書く。~~ **後に撤回**: 単一/複数ツリーの切り替え自体を廃止した（マルチルートは常に有効）。`parseContent` は古い content に残る `multiRoot` を読み飛ばすだけで、文書にもノードにも残さない。
- `/pub/:id.json` などノード単位の公開 API は影響なし。`formal/` の各ラウンドは当時のコードに対する記録なので更新しない。
