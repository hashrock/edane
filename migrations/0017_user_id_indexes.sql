-- アカウント削除（DELETE /api/account）は user_id で全テーブルを消す。索引のない列は
-- 表全体を走査する（D1 は読んだ行数で課金）ので張る。notes はノート一覧の絞り込みにも効く。
CREATE INDEX `idx_notes_user` ON `notes` (`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_api_tokens_user` ON `api_tokens` (`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_web_pages_user` ON `web_pages` (`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_oauth_codes_user` ON `oauth_codes` (`user_id`);
