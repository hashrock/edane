# 認証情報をサーバー側の行に揃え、ルートの方針を 1 つの表にする

## 背景

2026-10 のセキュリティ点検で、次の穴が見つかった。

- ルートごとに認可・CSRF・本文サイズ・エラー文言を手書きしていたので、点検のたびにどこかのルートが抜けていた。
- 認証情報が 3 系統に分かれていた。
  - セッション: 署名だけの Cookie
  - API トークン: 期限なし、全ルートで有効
  - OAuth のトークン: 専用テーブル
- そのため、失効（ログアウトしても Cookie が 30 日有効）、期限、スコープ、開いた WebSocket の追跡ができなかった。

## 決定

### ルートの方針は 1 つの表（`app/auth/routePolicy.ts`）

- **網羅**: 全ルートの「誰が呼べるか」を `ROUTE_POLICY` に宣言し、`routePolicyMiddleware` が強制する。表に無いルートは 403（fail closed）。`app/routePolicy.test.ts` が、表と登録済みのルートの完全一致を確かめる（server.ts を node から読めるよう、`cloudflare:workers` を vitest でスタブに差し替える）。
- **アクセスの種類**:
  - `public`
  - `user`（Cookie か API トークン）
  - `user-page`（未ログインはランディングへ）
  - `browser` / `browser-user`（`Authorization` 付きは断る）
  - `self`（セッションより前に mount し、自分で認証する `/mcp`・OAuth・stats）
- **API トークンのスコープ**: API トークンはノート（`notes` スコープ、ADR 0005）の API にだけ届く。トークン管理・OAuth の同意・画像・公開・サイトはブラウザのセッション限定。
- **CSRF**: `Authorization` の無い unsafe メソッドは、自オリジン（`Origin` か `Sec-Fetch-Site: same-origin`）からだけ受け付ける。SameSite=Lax はサイト単位なので、`*.hashrock.info` の兄弟からの送信を止められないため。
- **本文サイズ**: 既定 1 MiB。ルートごとに上書きできる。
- **エラー**: `app.onError` は固定の文言だけを返し、詳細はログに出す。
- **共通ヘッダー**: 全レスポンスに CSP（`frame-ancestors 'self'`、`script-src 'self' https://repos.hashrock.info`）と `nosniff` を付ける（`app/utils/securityHeaders.ts`）。
  - 自前の CSP を持つルート（公開サイト・画像・同意画面）はそれを保つ。
  - switcher の `v1.js` はその場で更新されるので SRI は付けられない。

### 認証情報はサーバー側の行

- **セッション**: `sessions` 行（30 日）。Cookie は署名付きでその id を指すだけ。
  - ログアウトで行を消すので、古い Cookie の複製も使えない。
  - 本番の Cookie 名は `__Host-session`（Secure・Path=/・Domain なし）で、兄弟サブドメインから上書きできない。
  - 毎リクエスト、主キーで D1 を 1 回読む。
- **API トークン**: `expires_at`（作成から 1 年。既存のものは移行時から 1 年）。
- **WebSocket**: 接続時の認証情報（`sessions` / `api_tokens` の行 id）を attachment に持つ。
  - NoteRoom は commit ごとの SELECT に `EXISTS (... WHERE id = ? AND expires_at > ?)` を足す。追加のクエリは無い。
  - 行が消えるか期限が切れると、その socket は 4404 で閉じる。クライアントは再接続をやめる。
  - 受信（他の commit の配信）は次に書くまで続く。
- **OAuth**: 入れ替え前のリフレッシュトークンのハッシュを `previous_refresh_hash` に残す。それがもう一度使われたら漏れたとみなし、grant ごと消す（OAuth 2.1 §4.3.1）。
- **リダイレクト URI**: カスタムスキームは、逆ドメイン形式と既知の MCP クライアント（cursor・vscode など）のものだけ。

## 見送ったもの

- **ユーザーのコンテンツを別オリジンから配信すること**: 画像・`/sites`・`/pub` を Cookie の無い別の登録ドメインから配信する案。#213 のヘッダーと sandbox で塞いではいるが、根本対策はこちら。ドメインと DNS が要るので別に判断する。
- **edane 自体を `hashrock.info` から独自ドメインへ移すこと**: SameSite が本来の強さで効くようになるが、URL が変わる。
- **「全端末からログアウト」の UI**: `sessions` をユーザーで消せば実現できる。

## 互換性と展開

- D1 migration `0013_credentials.sql` が要る。
- 既存のセッション Cookie（id を持たない旧形式）は無効になるので、全員が一度だけログインし直す。
- API トークンはそのまま 1 年使える。ノート以外の API（画像・公開など）を Bearer で呼んでいたクライアントは 403 になる。
