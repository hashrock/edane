# ADR 0007: Webページモード（プレゼンのページを縦に並べた公開ページ）

- ステータス: Accepted
- 日付: 2026-10-22
- 対象コード: `app/domain/pageTheme.ts`, `app/application/{slides,pageThemeStyle,scopedCss,webPagePublication}.ts`, `app/components/{PageView,WebPagePreview,PageThemePanel,SlideShow}.tsx`, `app/components/webpage.css`, `app/lib/{parallaxBackground,safeMarkdown}.ts`, `app/webpage-view.tsx`, `app/webpage-runtime.ts`, `app/server.ts`（`/w/:id`, `/api/notes/:id/webpage`）

## コンテキスト

プレゼンモード（`buildSlides`）は木をそのままスライドの列にできる。これを縦に並べれば、簡単な Web ページになる。既存の公開サイト（`/sites/:pubId`、枝 + JSX テンプレート）とは別の、ノート全体を手軽にページにする機能として作る。

## 決定

1. **ページはプレゼンと同じ規則で作る。** `buildSlides` の結果をそのまま使う（各ルートのタイトルページ、項目が `SLIDE_MAX_ITEMS` を超える枝はセクションと子ページに分割）。ノート全体を 1 サイトにする。
2. **テーマは文書のデータにする。** `MindMapDocument.theme`（`domain/pageTheme.ts`）を content JSON（v2）の任意フィールドとして保存する。そのため同期・Undo・暗号化はそのまま効き、公開ノートならサーバーが読める。同期パッチの `theme` は丸ごと 1 値で扱い、別のセッションが同時に変えると競合になる。無いときは `DEFAULT_PAGE_THEME` を使い、これまでの白いスライドと同じ見た目になる。値はすべて閉じた選択肢か範囲付きの値で、`normalizePageTheme` が唯一の入口になる。
3. **描画は 1 つのマークアップで共有する。** `PageView.tsx` を、スライドショー（variant `slide`）、エディタ右上のプレビューと公開ページ（variant `web`）が共有する。見た目は `webpage.css` の `wp-*` クラスに置く。このクラス名はユーザー CSS が狙う公開の契約なので、改名しないこと。
4. **ユーザー CSS はページ内に閉じ込める。** 公開ノートの閲覧者はアプリの中で作者の CSS を見ることになるため、次のようにする。
   - `@scope (.wp-root)` で包む。
   - 括弧の釣り合わない CSS は丸ごと捨てる。
   - at-rule は許可リスト（media / supports / container / keyframes）に絞る。スタイル規則の中にネストした at-rule も同じく絞り、エスケープした at-keyword は捨てる。keyframes はスコープの外へ出し、アプリのアニメーションと名前が衝突しないよう `wpu-` を前置する（`animation` の参照も書き換える）。
   - `<` はエスケープする。
   - エディタではページを `.wp-frame`（`contain: layout paint`）に入れ、`position: fixed` でもアプリを覆えないようにする。
5. **公開ページはサーバーで描く静的 HTML にする。** `/w/:id` は、毎回その時点のノートから `renderToString` で描く（保存＝反映、スナップショットは持たない）。スクリプトは `webpage-runtime.ts`（WebGL 背景とスクロールエフェクト）だけで、無くても全文が読める。CSP は `default-src 'none'` を基本にし、許可するのは自前のスクリプト、Google Fonts、https の画像だけ。Markdown は DOM の無いサーバーでも安全な `renderSafeMarkdown` で描く（生の HTML はテキストにし、URL は http(s) か同一オリジンのパスだけ通す）。
6. **公開の方針はノード公開と同じにする。** 公開ノートだけを、取り消せるランダム ID（`web_pages` 表、ノートに 1 つ）で配信する。`public_epoch` が一致するあいだだけ配信するので、一度非公開やゴミ箱になったノートは、持ち主がもう一度公開するまで止まったままになる。解除すると行を消し、再公開では新しい URL を発行する。
7. **背景はプリセットとパラメータで作る。** 1 つのフラグメントシェーダーに 4 種のプリセットを持たせ、色 2 つ・速さ・スクロール追従率（パララックス）を調整できる。任意の GLSL は受け付けない。WebGL が無い・失われたときは、単色の `--wp-bg` になる。`prefers-reduced-motion` ではアニメーションとスクロールエフェクトを止める。

## 影響

- `NodeType` を追加したら、`PageView.tsx` の `NodeContent` にもその描き方を足すこと（足さないとテキストとして描かれる）。
- テーマの項目を足すときは `normalizePageTheme`、`model.arb.ts` の `pageThemeArb`、テーマパネルの 3 か所を更新する。
