# Mindmap Lite

テキストのインデントからマインドマップを生成するWebアプリ。
Hono + Inertia.js + React 構成で、単一の Cloudflare Worker がサーバーとクライアントの両方を配信する。

## 構成

すべて `app/` 配下に集約:

- `app/server.ts` — Hono アプリ。Inertia ミドルウェアが `c.render("Page", props)` でページを描画。加えて Google OAuth (`/auth/*`) と自動保存用 JSON エンドポイント (`PUT /api/notes/:id`)。
- `app/pages/` — Inertia (React) ページ。`app/client.tsx` が解決。props はサーバーから直接渡るため、画面遷移にクライアント側のデータ取得は不要。
- `app/root-view.tsx` — SSR の HTML ドキュメント雛形（Vite クライアント + シリアライズされた Inertia ページ）。
- `app/components/`, `domain/`, `application/`, `lib/` — フレームワーク非依存の Konva マインドマップエディタと純粋なツリーモデル / エディタロジック。
- `app/db/`, `app/utils/` — Drizzle スキーマ、署名付きセッション Cookie、ノートの AES-256-GCM 暗号化。

## 開発

```bash
# 依存関係インストール
pnpm install

# DBマイグレーション（初回のみ）
pnpm migrate

# 起動
pnpm dev    # Vite + Cloudflare Worker が http://localhost:5173 で起動
```

ブラウザで `http://localhost:5173` を開く。

### 認証バイパス（ローカル開発）

`wrangler.jsonc` の `vars.DEV_BYPASS_AUTH` が有効なため、ローカルでは Google OAuth をスキップして Dev User として自動ログインする。シークレットは `.dev.vars` に置く。

## デプロイ

```bash
pnpm run deploy    # ビルドして Worker をデプロイ
```

## データベース

```bash
pnpm migrate          # ローカル D1 にマイグレーション適用
pnpm migrate:remote   # 本番 D1 にマイグレーション適用
pnpm generate         # app/db/schema.ts から新しいマイグレーションを生成
```

## 技術スタック

- **サーバー**: Hono + `@hono/inertia` (Cloudflare Workers)
- **クライアント**: Inertia.js + React 19 (`@inertiajs/react`)
- **ビルド**: Vite + `@cloudflare/vite-plugin` + `vite-ssr-components`
- **描画**: Konva, Tailwind CSS v4
- **DB**: Drizzle ORM + Cloudflare D1 (SQLite)
- **認証**: Google OAuth (`@hono/oauth-providers`)
- **暗号化**: 非公開ノートの内容を AES-256-GCM で暗号化
