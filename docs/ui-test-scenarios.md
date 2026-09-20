# UI テスト用シナリオ（`/__scenarios`）

Chrome MCP などのブラウザ自動操作で UI を試すとき、毎回手で初期状態を作らなくて済むように、
**URL を開くだけで所定の初期状態が新規に作られ、その画面へリダイレクトされる** route を用意している。
実装は `app/scenarios/` にまとまっていて、`app/server.ts` は `app.route("/__scenarios", scenarioRoutes())` で mount するだけ。

## エンドポイント

| URL | 動き |
|---|---|
| `GET /__scenarios` | 一覧ページ。名前・説明・行き先・リンクと、いまのログイン状態を表示する |
| `GET /__scenarios/:name` | シナリオの初期状態を**毎回新規に**作り、テスト対象の画面へ `303` でリダイレクトする |
| `GET /__scenarios/:name?format=json`（または `Accept: application/json`） | リダイレクトせず、作成した ID・URL・ユーザーを JSON で返す |

未知の名前は `404`。本番で未ログインなら HTML では一覧ページへ `303`（理由を表示）、JSON では `401` で `loginUrl` を返す。

## 誰のデータとして作られるか（AuthProvider）

ログイン状態は `app/auth/` の **AuthProvider**（`resolve` / `signIn` / `signOut`）が一手に決める。`selectAuth(env)` が env から 1 つ選び、ミドルウェアは `c.set("user", await auth.resolve(c))` するだけ。

| 環境 | プロバイダ | シナリオの持ち主 | JSON の `signedInAs` |
|---|---|---|---|
| ローカル（`DEV_BYPASS_AUTH` 有効） | `bypassAuth` | **シナリオごとの使い捨てユーザー**（`scenario-<name>-<tag>`、`<id>@scenario.invalid`）を作り、`auth.signIn` でそのユーザーとしてログインした状態になる。既存の Dev User のデータとは完全に隔離され、`empty` の一覧はそのノート 1 件だけ | `throwaway` |
| 本番（session 認証） | `sessionAuth` | ログイン中ユーザーの新規データ。未ログインなら通常のログイン導線へ | `current` |

- `bypassAuth` の `signIn` は署名付き `dev_impersonate` Cookie を書く（1 日）。`resolve` は `?guest=1` → impersonate Cookie → Dev User の順。ゲスト状態から `signIn` するとゲストは解除される。
- 本番の `sessionAuth` は `dev_impersonate` Cookie を一切読まない（`app/auth/auth.test.ts` で固定）。本番で任意ユーザーとしてログインする経路は無い。
- 各シナリオは毎回新しいユーザーを作るので、同じユーザーに複数シナリオを積むことはできない（隔離を優先）。Dev User に戻るには `/auth/logout`（impersonate Cookie を消す）。

## 安全性（本番でも公開してよい）

- **INSERT / UPSERT しかしない。** 既存のノート・公開・サイトを更新・削除する経路が無い（`app/scenarios/seed.ts` → `app/utils/noteRepository.ts`。server.ts のハンドラと同じ書き込み関数）。
- **自分のデータだけ。** 本番ではログイン中ユーザーの新規データとして作られる。ノートのタイトルはすべて `scenario-<name>-<6桁ランダム>` で始まるので、あとから一覧で見分けて捨てられる。
- **認証を迂回しない。** 使い捨てユーザーでの `signIn` は `bypassAuth` のときだけ（`resolveScenarioAccess` が `auth.kind` で分岐）。

## シナリオ一覧

| 名前 | 作られる状態 | 行き先 |
|---|---|---|
| `empty` | 空のトップレベルノード 1 つだけの非公開ノート（新規ノートの初期画面） | `/notes/:id/edit` |
| `typical` | text / link / image / markdown の各ノード、チェックボックス（済・未）、折りたたみ、太字・大きい文字、複数の木を持つノート。加えてピン留めノート 1 件・公開ノート 1 件 | `/notes/:id/edit` |
| `large` | 子 40 個の広い木、深さ 15 の木、長文（日本語・空白なしの長い単語・長い Markdown）、`position` で位置固定した木。加えて一覧を埋める 20 件（一部公開・長いタイトル） | `/notes/:id/edit` |
| `trash` | ゴミ箱に非公開 1 件・公開 1 件 | `/trash` |
| `public` | 公開ノート + 枝のノード公開。`/pub/:id.json` `/pub/:id.md` が生きていて、サイトはまだ無い（サイトエディタは下書き状態） | `/notes/:id`（閲覧ページ） |
| `site` | 公開ノート + ノード公開 + ビルド済みサイト。`/sites/:pubId` で配信され、サイトエディタは「公開済み」になる | `/sites/:pubId/edit` |

`site` の HTML/CSS は **golden fixture**（`app/scenarios/siteGolden.ts`）。ブラウザの Worker と同じコンパイラ（ono + UnoCSS）で既定テンプレートから作った本物の成果物で、`siteGolden.test.ts` が毎回コンパイルし直して一致を検証する。テンプレートやコンパイラを変えたら次のコマンドで更新する：

```bash
UPDATE_GOLDEN=1 pnpm vitest run --project node app/scenarios/siteGolden.test.ts
```

## Chrome MCP からの使い方

1. 開発サーバを起動する（`pnpm dev` → `http://localhost:5173`）。
2. JSON で状態を作り、ID と URL を受け取る：

   ```bash
   curl -s 'http://localhost:5173/__scenarios/site?format=json' | jq .
   ```

   ```json
   {
     "scenario": "site",
     "tag": "3f9a1c",
     "user": { "id": "<uuid>", "email": "<uuid>@scenario.invalid", "name": "scenario-site-3f9a1c" },
     "signedInAs": "throwaway",
     "redirect": "http://localhost:5173/sites/<pubId>/edit",
     "notes": [{ "key": "main", "id": "…", "title": "scenario-site-3f9a1c", "isPublic": true, "editUrl": "…", "viewUrl": "…" }],
     "publications": [{ "id": "<pubId>", "jsonUrl": "…/pub/<pubId>.json", "markdownUrl": "…/pub/<pubId>.md", "siteEditUrl": "…" }],
     "sites": [{ "publicationId": "<pubId>", "url": "http://localhost:5173/sites/<pubId>", "editUrl": "…" }]
   }
   ```

3. ブラウザで `redirect`（または `notes[].editUrl` など任意の URL）を開いて操作する。
   ID を控える必要がなければ、ブラウザで直接 `http://localhost:5173/__scenarios/typical` を開くだけでよい。

   注意: ログイン状態は Cookie なので、curl で作った使い捨てユーザーにブラウザはなっていない。ブラウザで操作するならブラウザで `/__scenarios/<name>` を開く（JSON は `?format=json` を付けて同じブラウザで開けば Cookie も揃う）。

`notes[].key` は計画内での役割（`main` / `pinned` / `public` / `list-1` …）で、同じシナリオを何度実行しても変わらない。

## シナリオを足すとき

1. `app/scenarios/fixtures.ts` に `build<Name>(ctx)` を書く（純粋関数。ID は `ctx.nextId()`、タイトルは `scenarioTitle(name, ctx.tag, …)`）。
2. `app/scenarios/catalog.ts` の `SCENARIO_NAMES` と `SCENARIOS` に追加する（`satisfies` で両方書くまでコンパイルが通らない）。
3. `app/scenarios/scenarios.test.ts` の共通テストが自動で走る。固有の期待があれば足す。
4. この表を更新する。

テスト: `pnpm vitest run --project node app/scenarios app/auth`

ハンドラを DB なしでテストするには、固定ユーザーを返すモック AuthProvider を `authMiddleware` に渡す（例: `app/scenarios/routes.test.ts`）。
