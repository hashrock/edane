# アップロード画像を別オリジンから配信し、SVG を解禁する

## 背景

SVG のアップロードを拒否していた。本体オリジン（`edane.hashrock.info`）から SVG を配信すると、URL を直接開いたときに中のスクリプトが本体オリジンで動く stored XSS になるため。

「画像の配信ヘッダー（CSP `sandbox` / `nosniff`）があるなら許可してよいのでは」も検討した。しかし、ヘッダーが付かない経路が1本でもあれば破れる。アプリ側で SVG をインライン化したくなった時点で即 XSS になる。そのため、ヘッダー1枚に頼るのはやめた。

## 決定

### 画像は assets ホストから配信する（`app/utils/assetsHost.ts`）

- 配信元は `edane-assets.hashrock.info`（`wrangler.jsonc` の `vars.ASSETS_ORIGIN`、custom domain）。本体と同じ Worker で、Host を見て分岐する。
- assets ホストでは `GET /api/images/:id/raw` だけが存在し、他は全部 404。アプリのページやセッション付き API はそこでは動かない。
- 本体ホストの `/api/images/:id/raw` は assets ホストへ 302。保存済みノートは相対 URL を持っており（暗号化された行もあるので SQL で書き換えない）、`<img>` はリダイレクトを追える。
- アップロード API が返す URL は assets ホストの絶対 URL。
- dev ビルドは `ASSETS_ORIGIN` を無視し、本体オリジンから配信する。

### サブドメインで十分とした理由

別の登録ドメイン（`*.usercontent.net` 的なもの）は取らない。サブドメインは same-site なので、本来の脅威は CSRF と Cookie の注入だが、どちらも対策済み。

- CSRF: `sameOriginRequest`（`app/auth/routePolicy.ts`）が `Origin` の完全一致を見る。SameSite には頼っていない。
- Cookie: セッションは `__Host-session`、OAuth の戻り先は `__Host-oauth_return` なので、サブドメインからは上書きできない。

### SVG は二重の構えで許可する（`app/domain/imageStorage.ts`）

- `sniffImageType` はテキストとして判定する。UTF-8 であり、BOM・空白・XML 宣言・コメント・DOCTYPE を飛ばした最初の要素が `<svg` なら SVG とみなす。内部サブセット（`[...]`）付きの DOCTYPE は断る。
- assets オリジンが無い環境では、アップロード時に SVG を断る。
- 配信は assets ホストでも `sandbox` CSP と `nosniff` を付ける。本体オリジンから SVG を返す場合（dev）は `attachment` にする。
- **アプリは SVG を `<img>`（または CSS の画像）でだけ描く。** `fetch` して DOM にインライン化しない。`<img>` の中の SVG はスクリプトを実行しない。

## 結果

- 過去に本体オリジンへ保存された相対 URL の画像は、リダイレクト1回分遅くなる。
- `hashrock.info` 配下の他サービスが SameSite だけの CSRF 対策や `Domain=hashrock.info` の Cookie に頼っていると、assets サブドメインの SVG（ただし sandbox 下）から狙われうる。edane の外の話なので、各サービス側で確認する。
