# リモート MCP サーバー（`POST /mcp`）

AI エージェント（Claude Code、Claude Desktop、ChatGPT、MCP Inspector など）から edane のノートを読み書きするための [Model Context Protocol](https://modelcontextprotocol.io) サーバー。Worker の `/mcp` で Streamable HTTP（stateless）として動く。

## 接続

接続の方法は 2 通りある。

- **OAuth（URL だけ）**: ChatGPT や claude.ai のコネクタのように、URL を登録すると edane のログインと許可の画面が開くクライアント。トークンの発行は要らない。下の「OAuth で接続する」。
- **API トークン（ヘッダー）**: `Authorization` ヘッダーを設定できるクライアント（Claude Code、Cursor など）。以下の手順。

1. 設定画面（`/settings`）の「APIトークン」で「新規作成」を押し、表示されたトークン（`edane_…`）を控える。トークンは発行時にしか表示されない。
2. クライアントに URL とヘッダーを登録する。設定画面はトークン発行直後に、下のクライアントごとの設定例をトークン入りで表示する（`app/application/mcpClientConfigs.ts`）。

   ヘッダーを付けられるクライアントなら、どれでも同じ URL とヘッダーで接続できる。以下の `edane_xxxxxxxx` は発行したトークンに置き換える。

### Claude Code

```bash
claude mcp add --transport http edane https://edane.hashrock.info/mcp \
  --header "Authorization: Bearer edane_xxxxxxxx"
```

### Claude Desktop

カスタムコネクタ（URL だけ）で OAuth 接続するのが簡単（下の「OAuth で接続する」）。API トークンを使うなら、カスタムコネクタはヘッダーを付けられないので、[mcp-remote](https://www.npmjs.com/package/mcp-remote) で stdio に橋渡しする（Node.js が必要）。`claude_desktop_config.json`（設定 → 開発者 → 構成を編集）に追記する。ヘッダー値は空白を含むので env 経由で渡す。

```json
{
  "mcpServers": {
    "edane": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://edane.hashrock.info/mcp", "--header", "Authorization:${EDANE_AUTH}"],
      "env": { "EDANE_AUTH": "Bearer edane_xxxxxxxx" }
    }
  }
}
```

### Cursor

`~/.cursor/mcp.json`（プロジェクト単位なら `.cursor/mcp.json`）:

```json
{
  "mcpServers": {
    "edane": {
      "url": "https://edane.hashrock.info/mcp",
      "headers": { "Authorization": "Bearer edane_xxxxxxxx" }
    }
  }
}
```

### VS Code（GitHub Copilot のエージェントモード）

`.vscode/mcp.json`（ユーザー設定なら「MCP: Open User Configuration」）。キーが `servers` で `type` が必要な点が他と違う:

```json
{
  "servers": {
    "edane": {
      "type": "http",
      "url": "https://edane.hashrock.info/mcp",
      "headers": { "Authorization": "Bearer edane_xxxxxxxx" }
    }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`。URL のキーは `serverUrl`:

```json
{
  "mcpServers": {
    "edane": {
      "serverUrl": "https://edane.hashrock.info/mcp",
      "headers": { "Authorization": "Bearer edane_xxxxxxxx" }
    }
  }
}
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.edane]
url = "https://edane.hashrock.info/mcp"
http_headers = { Authorization = "Bearer edane_xxxxxxxx" }
```

トークンを設定ファイルに書きたくなければ、`http_headers` の代わりに `bearer_token_env_var = "EDANE_TOKEN"` として環境変数 `EDANE_TOKEN` にトークンを入れる。

### Gemini CLI

`~/.gemini/settings.json`。Streamable HTTP の URL のキーは `httpUrl`（`url` は SSE 用）:

```json
{
  "mcpServers": {
    "edane": {
      "httpUrl": "https://edane.hashrock.info/mcp",
      "headers": { "Authorization": "Bearer edane_xxxxxxxx" }
    }
  }
}
```

### MCP Inspector（動作確認）

```bash
npx @modelcontextprotocol/inspector
```

Transport Type を「Streamable HTTP」、URL を `https://edane.hashrock.info/mcp` にし、Authentication の Header Name に `Authorization`、Bearer Token にトークンを入れて Connect する。

API トークンは作成から 1 年で切れ、ノートの API（`/mcp`・同期・ノートの作成と更新）にだけ使える（画像・公開・トークン管理などはブラウザのセッション限定。ADR 0006）。トークンを失効させるには設定画面で削除する。トークンを持っている人はそのユーザーの全ノートを読み書きできる。

## OAuth で接続する

URL `https://edane.hashrock.info/mcp` をクライアントに登録すると、クライアントが edane のログイン画面（Google）と許可の画面をブラウザで開く。「許可する」を押すと接続が終わる。トークンを手で扱う必要はない。

### ChatGPT（Web / Desktop）

1. 設定 → アプリとコネクタ → 詳細設定で「開発者モード」を有効にする（プランやワークスペースの設定によっては管理者の許可が要る）。
2. 「作成」（コネクタの追加）で、名前に `edane`、MCP サーバーの URL に `https://edane.hashrock.info/mcp`、認証に「OAuth」を選ぶ。
3. 開いた edane の画面でログインし、「許可する」を押す。

Desktop アプリも同じアカウントのコネクタを使う。メニューの名前は ChatGPT 側の更新で変わることがある。

### Claude（claude.ai / Claude Desktop）

設定 → コネクタ → 「カスタムコネクタを追加」で、URL に `https://edane.hashrock.info/mcp` を入れて追加し、「連携」から edane の画面で許可する。

### 接続の解除

設定画面の「接続中のアプリ（OAuth）」に、許可したクライアントが並ぶ。「接続解除」でそのクライアントのトークンはすぐ無効になる（もう一度使うには許可し直す）。

### 仕組み

edane 自身が OAuth 2.1 の認可サーバーになる（MCP の認可仕様に沿う）。方針は [ADR 0005](adr/0005-mcp-oauth.md)。

| エンドポイント | 内容 |
|---|---|
| `GET /.well-known/oauth-protected-resource/mcp`（とルート） | 保護リソースのメタデータ（RFC 9728）。`/mcp` の 401 の `WWW-Authenticate` の `resource_metadata` がここを指す |
| `GET /.well-known/oauth-authorization-server` | 認可サーバーのメタデータ（RFC 8414） |
| `POST /oauth/register` | 動的クライアント登録（RFC 7591）。既定は公開クライアント、`client_secret_post` / `client_secret_basic` を求められればシークレットも発行。IP ごとに 1 分 10 件まで（超えると 429）。誰にも許可されなかったクライアントは 1 日で消える |
| `GET /oauth/authorize` | 同意画面。未ログインなら Google ログインを挟んで戻ってくる。PKCE（S256）必須 |
| `POST /oauth/token` | `authorization_code` と `refresh_token`。アクセストークン 1 時間、リフレッシュトークンは使うたびに入れ替わり 90 日 |

スコープは `notes`（ノートの読み書き）だけ。アクセストークンは API トークンと同じく、そのユーザーの全ノートを読み書きできる。

## ツール

| ツール | 内容 |
|---|---|
| `list_notes` | 自分のノート（ゴミ箱を除く）。ピン留め → 更新が新しい順。`query` でタイトルを部分一致検索 |
| `read_note` | `outline`（既定）: 「Markdownとしてコピー」と同じ箇条書き（`add_nodes` がそのまま読める形）で、各行末の `{id=…}` が編集ツールに渡すノード id。markdown ノードの複数行本文は 1 行に畳まれる。`json`: 保存形式 v2（省略なし） |
| `create_note` | 非公開ノートを作る。`markdown` の最上位が 1 項目ならそれが木の根、複数ならタイトルを根にしてその下に並べる |
| `rename_note` | タイトルを変える |
| `add_nodes` | Markdown（見出し・箇条書き・`- [ ]` タスク）からノードを追加。`parentId` = その子の末尾、`afterId` = 直後の兄弟（ルートの直後なら子）、どちらも無し = 最初の木の根の子の末尾 |
| `update_node` | 本文（`text`）とチェックボックス（`checked`: true / false / null = 外す）を書き換える |
| `delete_node` | サブツリーごと削除。最後の木の根を消すと空の根が 1 つ残る |

編集ツールは確定した編集後のアウトライン（同時に併合された他のクライアントの編集も含む）を返すので、続けて編集するときに読み直さなくてよい。

編集ツール（`rename_note` / `add_nodes` / `update_node` / `delete_node`）は任意の `operationId` を受け付ける。応答が届かずに同じ編集を送り直すとき、同じ値を渡せばノートには 1 回だけ当たり、最初と同じノード id が返る。同じ値を別の編集に使い回すと断られる。

## 実装

- `app/mcp/protocol.ts` — JSON-RPC（`initialize` / `ping` / `tools/list` / `tools/call`）。HTTP と DB に依存しない。
- `app/mcp/tools.ts` — ツール定義。引数の検証 → 読み込み → 変換 → 保存だけを行う。
- `app/mcp/noteStore.ts` — ノートの読み書き。一覧は `utils/noteRepository.ts` の `listLiveNotes`（/notes と共通）。既存ノートの読み込みと書き込みはエディタと同じノートごとの `NoteRoom`（`app/sync/room.ts`、ADR 0004）を通す。編集は依頼（`NoteEditRequest`、ノード id を振る前の形）ごと `NoteRoom.applyEdit` に渡し、`NoteRoom` がその時点のノートに 1 回の順番（`ordered()`）の中で読み込み → 編集 → commit → 配信まで行う。読んでから書くまでの間に他の commit は入らないので、ツールの応答は確定した状態そのもの。開いているエディタの編集とは差分の単位で併合され、version が進み、開いているエディタへもその場で配信される。`operationId` があれば受領記録のダイジェストは依頼から取り、新しいノードの id もそこから決まる（`op-<operationId>-<n>`）。何も変えない編集は commit しない（version は進まない）。公開 = 平文、非公開 = 暗号化の保存ポリシーは `NoteRoom` が守る。所有者とゴミ箱の確認も `NoteRoom` が内容と同じ 1 行の SELECT で行い（`updatedAt` もその行のもの）、MCP 側で事前に読み直さない。
- `NoteRoom` の想定内の拒否（ノートなし・復号失敗・競合・大きすぎる など）は例外ではなく `RoomResult` の `{ ok: false, code }` で返る（`app/application/syncOperations.ts` の `RoomRejection`。DO の RPC 越しには例外の型が残らないため）。呼び出し側（WebSocket・旧 PUT・MCP）がそれぞれの相手向けの文言にする。それ以外の例外（D1 の障害など）はエージェントには `Internal error` だけを返し、詳細はサーバーのログにだけ残す。
- `app/application/noteEdits.ts` — アウトラインの生成（`modelToMarkdown` に id を付けるだけ）と編集。編集はすべて `EditorAction` として `editorReducer` に通すので、ルートが必ず 1 つ以上あること、`nestUnder`、ルートの兄弟は子に読み替える、といった不変条件はブラウザでの編集と共通になる。

### HTTP の振る舞い

- 認証は `Authorization: Bearer <API トークン または OAuth のアクセストークン>` だけ。セッション Cookie では通らない（別サイトからのフォーム送信でノートを書き換えられないように）。そのため認証ミドルウェアより前に mount している。トークンが無い・一致しない場合は 401 + `WWW-Authenticate: Bearer realm="edane", resource_metadata="…/.well-known/oauth-protected-resource/mcp"`（トークンを送って断られたときは `error="invalid_token"` も付く。OAuth クライアントはこれを見てリフレッシュか認可をやり直す）。アクセストークンは接頭辞 `edane_oat_` で見分け、どちらの種類も 1 回の検索で済ませる。
- 要求本文は 1 MiB まで（超えたら読まずに 413）。ツールの引数は宣言したもの以外を受け付けず、文字列には上限がある（タイトル 200 / ノード本文 100,000 / Markdown 500,000 / id 200 文字、コードポイントで数える）。上限は `app/application/agentInput.ts`、宣言（`additionalProperties: false` と `maxLength`）は `tools.ts` の inputSchema で、`protocol.ts` がツールを呼ぶ前に同じ宣言で検査する。
- 要求には 200 で `application/json` を返す。通知だけなら 202（本文なし）。旧版のバッチ（配列）は最大 20 件まで。
- サーバーから能動的に送るものもセッションも無いので、`GET`（SSE）と `DELETE` は 405。
- Bearer はブラウザが勝手に付けないので、CORS は全オリジンに開けている（ブラウザ版の MCP Inspector から使える）。

## ローカルで試す

```bash
pnpm dev
# 設定画面でトークンを発行してから:
curl -s localhost:5173/mcp -H "Authorization: Bearer edane_xxx" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_notes","arguments":{}}}'
```

Claude Code から MCP で編集し、開いているエディタへの反映（リロードなし）と、エディタで入力中の同時編集の併合までを実通信で確かめるスクリプト。トークンは dev の認証バイパスで自動発行し、MCP の設定は一時ファイルを `--mcp-config` で渡すだけなので Claude Code の設定には書かない。

```bash
pnpm dev --port 5199 --strictPort &
node scripts/mcp-live-e2e.mjs   # 接続先は EDANE_BASE_URL で変えられる。PATH 上に claude が必要
```
