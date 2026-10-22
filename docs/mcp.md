# リモート MCP サーバー（`POST /mcp`）

AI エージェント（Claude Code、Claude Desktop、MCP Inspector など）から edane のノートを読み書きするための [Model Context Protocol](https://modelcontextprotocol.io) サーバー。Worker の `/mcp` で Streamable HTTP（stateless）として動く。

## 接続

1. 設定画面（`/settings`）の「APIトークン」で「新規作成」を押し、表示されたトークン（`edane_…`）を控える。トークンは発行時にしか表示されない。
2. クライアントに URL とヘッダーを登録する:

   ```bash
   claude mcp add --transport http edane https://edane.hashrock.info/mcp \
     --header "Authorization: Bearer edane_xxxxxxxx"
   ```

   ヘッダーを付けられるクライアントなら、どれでも同じ設定で接続できる。

トークンを失効させるには設定画面で削除する。トークンを持っている人はそのユーザーの全ノートを読み書きできる。

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
- `app/application/noteEdits.ts` — アウトラインの生成（`modelToMarkdown` に id を付けるだけ）と編集。編集はすべて `EditorAction` として `editorReducer` に通すので、ルートが必ず 1 つ以上あること、`nestUnder`、スキーマのレコード補完（`conformEntering`）、ルートの兄弟は子に読み替える、といった不変条件はブラウザでの編集と共通になる。

### HTTP の振る舞い

- 認証は `Authorization: Bearer <API トークン>` だけ。セッション Cookie では通らない（別サイトからのフォーム送信でノートを書き換えられないように）。そのため認証ミドルウェアより前に mount している。トークンが無い・一致しない場合は 401 + `WWW-Authenticate: Bearer`。
- 要求本文は 1 MiB まで（超えたら読まずに 413）。ツールの引数は宣言したもの以外を受け付けず、文字列には上限がある（タイトル 200 / ノード本文 100,000 / Markdown 500,000 / id 200 文字、コードポイントで数える）。上限は `app/application/agentInput.ts`、宣言（`additionalProperties: false` と `maxLength`）は `tools.ts` の inputSchema で、`protocol.ts` がツールを呼ぶ前に同じ宣言で検査する。
- 要求には 200 で `application/json` を返す。通知だけなら 202（本文なし）。旧版のバッチ（配列）は最大 20 件まで。
- サーバーから能動的に送るものもセッションも無いので、`GET`（SSE）と `DELETE` は 405。
- Bearer はブラウザが勝手に付けないので、CORS は全オリジンに開けている（ブラウザ版の MCP Inspector から使える）。

### 制限

- OAuth には対応していないので、ヘッダーを設定できないクライアント（claude.ai のカスタムコネクタなど）からは接続できない。

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
