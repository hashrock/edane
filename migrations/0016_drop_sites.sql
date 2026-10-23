-- 実験的な公開サイト機能（/sites/:pubId、枝 + JSX テンプレート）を廃止した。
-- インデックス idx_sites_user はテーブルと一緒に消える。
DROP TABLE IF EXISTS `sites`;
