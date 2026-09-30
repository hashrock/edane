# ADR 0003: スキーマを公開サイトから枝（ノード）へ移す

- ステータス: Accepted
- 日付: 2026-09-30
- 対象コード: `app/domain/branchSchema.ts`, `app/application/editorReducer.ts`, `app/application/schemaDecorations.ts`, `app/application/siteSchema.ts`, `app/server.ts`（`/sites/:pubId/edit`）

## コンテキスト

公開サイト（`/sites/:pubId`）は「枝の子 = レコード、レコードの子の index i = フィールド i」と読み、その位置に名前と型を付けるスキーマを `sites.schema` 列に持っていた。スキーマを使うのは公開の時点だけで、マップを書いている間は、どの位置に何を書けばいいかが見えなかった。型の食い違いも、公開エディタを開くまで分からなかった。

## 決定

1. **スキーマはコレクションノードの属性 `MindMapModel.schema`（文字列）に持つ。** 子 = レコード、レコードの子の index i = フィールド i という読み方は変えない。
2. **書式は `key[]:type` を拡張する**（`domain/branchSchema.ts`）。キーは ASCII 識別子のまま（テンプレートでは `item.key` になる）。
   - 型: `text / image / link / markdown`（ノード種別）、`check`（`checked` を真偽値として読む）、`number` / `date`（text の中身の形）
   - `key[]:type` の型は、フィールドノードの子である**各要素**に当たる
   - `key[]{…}` は入れ子のコレクション。スキーマは外側に書き、全レコードで共通にする
3. **型は注釈であって強制しない。** 読めない値は `fieldIssue` で報告するだけ（エディタでは ⚠、公開側では警告）。フィールドを並べ替えて index がずれても補正しない。空の text ノードは「まだ書いていない」ので不一致にしない。
4. **スキーマは右クリック「スキーマを設定…」のダイアログで、フィールド行のリスト（キー・型・配列・▲▼の並べ替え・`records{…}` の入れ子）として編集する。** テキスト書式のタブにも切り替えられ、どちらも同じ文字列として保存する。行の操作と検証は `application/schemaDraft.ts`、キーの検証はパーサと共有する（`keyError`）。
5. **エディタは、レコードの位置に入ってきたノードに、足りないフィールドを型付きの空ノードで補う**（`conformEntering`）。reducer の入口の1箇所で、次の操作のあとにだけ走らせる: Enter、Tab / Shift+Tab、兄弟・子の挿入、ペースト、`insertNodes`、DnD（`moveBranch`）。補うのは末尾の不足分だけで、既にある子は変えない。フィールドの位置に**新しく作られた空の**ノードには、そのフィールドの型を当てる。Backspace / Delete による連結は対象外にする（レコードを連結するとそのフィールドがレコードの位置へ昇格するので、それに雛形を付けても散らかるだけ）。補完は同じ state 変化に含まれるので、Undo 1回でまとめて戻る。
6. **フィールド名のラベルは canvas と outline の両方に出す**（`schemaDecorations` を共有する）。canvas では兄弟の縦の間隔が 10px しかないので、ラベルは箱の上ではなく、親とのあいだの横の隙間（箱の左端の手前）に置く。スキーマを持つノードには `{…}` のタグを付ける。
7. **公開側は枝のスキーマに一本化する。** `effectiveSchema(data)` は公開した枝の根の `schema` を読み、無い・空・不正なら従来どおり推定する。保存 API は `schema` を受け取らない。
8. **移行は遅延で行う。** `/sites/:pubId/edit` を開いたとき、枝にスキーマが無く `sites.schema` に値があれば、それを枝へ書き込み（ノートを復号 → 更新 → 再暗号化）、`sites.schema` を空にする。枝に既にスキーマがあれば枝を優先する。`sites.schema` 列は移行が行き渡ったあとで削除する。

## 影響

- `NodeType` を追加すると、`FieldType` 経由で `FIELD_TYPES`（branchSchema）と `FIELD_RENDERERS`（siteSchema）がコンパイルエラーになる。
- `SiteItem` の値は `string | number | boolean | string[] | SiteItem[]` になった（`check` → boolean、`number` → number、入れ子 → レコードの配列）。
- 1つの枝を2つのサイトで別のスキーマで読むことはできなくなった（以前の設計では可能だった）。必要になったら、サイト側の上書きとして足し直す。
- 移行と同時にノートがエディタで開かれていると、エディタの次の保存が移行前の文書で上書きし、移行したスキーマが消えることがある。その場合もサイトは推定スキーマで動き続け、スキーマはノートから設定し直せる。
