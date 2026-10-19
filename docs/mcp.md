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
| `read_note` | `outline`（既定）: 1 行 1 ノードのアウトラインで、各行末の `{id=…}` が編集ツールに渡すノード id。`json`: 保存形式 v2 |
| `create_note` | 非公開ノートを作る。`markdown` の最上位が 1 項目ならそれが木の根、複数ならタイトルを根にしてその下に並べる |
| `rename_note` | タイトルを変える |
| `add_nodes` | Markdown（見出し・箇条書き・`- [ ]` タスク）からノードを追加。`parentId` = その子の末尾、`afterId` = 直後の兄弟（ルートの直後なら子）、どちらも無し = 最初の木の根の子の末尾 |
| `update_node` | 本文（`text`）とチェックボックス（`checked`: true / false / null = 外す）を書き換える |
| `delete_node` | サブツリーごと削除。最後の木の根を消すと空の根が 1 つ残る |

編集ツールは編集後のアウトラインを返すので、続けて編集するときに読み直さなくてよい。

## 実装

- `app/mcp/protocol.ts` — JSON-RPC（`initialize` / `ping` / `tools/list` / `tools/call`）。HTTP と DB に依存しない。
- `app/mcp/tools.ts` — ツール定義。引数の検証 → 読み込み → 変換 → 保存だけを行う。
- `app/mcp/noteStore.ts` — D1 への読み書き。公開 = 平文、非公開 = 暗号化の保存ポリシーはエディタの保存と同じ（`crypto.ts`）。
- `app/application/noteEdits.ts` — アウトラインの生成と編集。編集はすべて `EditorAction` として `editorReducer` に通すので、ルートが必ず 1 つ以上あること、`nestUnder`、スキーマのレコード補完（`conformEntering`）、ルートの兄弟は子に読み替える、といった不変条件はブラウザでの編集と共通になる。

### HTTP の振る舞い

- 認証は `Authorization: Bearer <API トークン>` だけ。セッション Cookie では通らない（別サイトからのフォーム送信でノートを書き換えられないように）。そのため認証ミドルウェアより前に mount している。トークンが無い・一致しない場合は 401 + `WWW-Authenticate: Bearer`。
- 要求には 200 で `application/json` を返す。通知だけなら 202（本文なし）。旧版のバッチ（配列）は最大 20 件まで。
- サーバーから能動的に送るものもセッションも無いので、`GET`（SSE）と `DELETE` は 405。
- Bearer はブラウザが勝手に付けないので、CORS は全オリジンに開けている（ブラウザ版の MCP Inspector から使える）。

### 制限

- ブラウザのエディタでそのノートを開いたまま MCP で編集すると、エディタの次の自動保存で MCP の変更が上書きされる（エディタはノート全体を保存するため）。MCP で編集するノートはエディタで開かないか、編集後に再読み込みする。
- OAuth には対応していないので、ヘッダーを設定できないクライアント（claude.ai のカスタムコネクタなど）からは接続できない。

## ローカルで試す

```bash
pnpm dev
# 設定画面でトークンを発行してから:
curl -s localhost:5173/mcp -H "Authorization: Bearer edane_xxx" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_notes","arguments":{}}}'
```
