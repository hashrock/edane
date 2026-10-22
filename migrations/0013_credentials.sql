-- Server-side credentials (docs/adr/0006-credentials.md).
-- Browser sessions become rows the cookie points at, so signing out ends them server-side.
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_user` ON `sessions` (`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_sessions_expires` ON `sessions` (`expires_at`);
--> statement-breakpoint
-- API tokens expire a year after creation; existing ones get a year from now.
ALTER TABLE `api_tokens` ADD `expires_at` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE `api_tokens` SET `expires_at` = (CAST(strftime('%s', 'now') AS INTEGER) + 365 * 24 * 60 * 60) * 1000;
--> statement-breakpoint
-- Refresh token reuse detection: the hash each rotation replaced.
ALTER TABLE `oauth_grants` ADD `previous_refresh_hash` text;
--> statement-breakpoint
CREATE INDEX `idx_oauth_grants_previous_refresh` ON `oauth_grants` (`previous_refresh_hash`);
