-- Expired OAuth rows are purged (docs/adr/0005-mcp-oauth.md). A client keeps its row once a user
-- has approved it (authorized_at); a client nobody approved is deleted a day after registration.
ALTER TABLE `oauth_clients` ADD `authorized_at` integer;
--> statement-breakpoint
UPDATE `oauth_clients` SET `authorized_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE EXISTS (SELECT 1 FROM `oauth_grants` WHERE `oauth_grants`.`client_id` = `oauth_clients`.`id`);
--> statement-breakpoint
CREATE INDEX `idx_oauth_codes_expires` ON `oauth_codes` (`expires_at`);
--> statement-breakpoint
CREATE INDEX `idx_oauth_grants_refresh_expires` ON `oauth_grants` (`refresh_expires_at`);
--> statement-breakpoint
CREATE INDEX `idx_oauth_clients_unauthorized` ON `oauth_clients` (`created_at`) WHERE `authorized_at` IS NULL;
--> statement-breakpoint
CREATE INDEX `idx_oauth_codes_client` ON `oauth_codes` (`client_id`);
--> statement-breakpoint
CREATE INDEX `idx_oauth_grants_client` ON `oauth_grants` (`client_id`);
