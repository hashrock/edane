# ノートの自動バックアップとデータのエクスポート

## 決定

### 自動バックアップ（版履歴）

- `note_backups` テーブル（migration `0017`）に、ノートの**変更前**の内容を保存する。書くのは NoteRoom の `persist` だけで、commit と同じ D1 batch に入れる。
  - 挿入は読み込んだときの version を条件にするので、commit が入らなければバックアップも入らない。
- 頻度と保持数は `app/application/noteBackups.ts` で決める。
  - 1 ノートにつき 1 時間に 1 回まで（`BACKUP_INTERVAL_MS`）。最新のバックアップ時刻は DO のメモリにキャッシュする（1 ノート = 1 オブジェクト）。
  - 1 ノートにつき最新 50 件（`MAX_BACKUPS_PER_NOTE`）。古いものは次にバックアップするときに消す。
- **本文は常に暗号化する**（AAD はバックアップ自身の id）。公開ノートでも暗号化する。こうしておけば、あとでノートを非公開にしたときに平文の履歴が残らない。タイトルは `notes.title` と同じく平文で持つ。
- 復元（`POST /api/notes/:id/backups/:backupId/restore`）は `NoteRoom.restore` を通す、普通の commit として扱う。開いているエディタにもそのまま配信される。復元の直前には間隔に関係なく今の内容をバックアップするので、復元そのものを取り消せる。
- UI は `/notes/:id/history`。一覧で選んだ版を閲覧専用の NoteEditor で表示する。ノート一覧のメニューと、コマンドパレットから開く。
- ノートを完全に削除すると、バックアップも一緒に消える（`ON DELETE CASCADE`）。

### データのエクスポート

- `GET /api/export`（`browser-user`）は、ユーザーの全ノートをゴミ箱の中も含めて ZIP で返す。中身は `app/application/dataExport.ts` が組み立てる。
  - `notes.json`: メタデータと v2 の content。完全なデータで、`format: "edane-export"` と `version: 1` を持つ。
  - `notes/*.md` と `trash/*.md`: 人が読むための Markdown。
- 復号できなかったノートも黙って落とさない。JSON に `content: null, error` として載せる。
- 画像は含めない。本文中の URL はそのまま残る。
- ZIP は `app/lib/zip.ts` の無圧縮の writer で作る。依存を増やさないため。ファイル名は UTF-8 で書き、フラグで示す。

## 見送ったもの

- サーバー全体を R2 へ定期的にダンプすること。運用者向けの復旧は D1 Time Travel で足りる。
- エクスポートしたデータのインポート。`notes.json` は再取り込みを前提にした形にしてある。
