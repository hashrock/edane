-- OAuth 2.1 authorization server for the remote MCP endpoint (docs/adr/0005-mcp-oauth.md).
-- Clients come from dynamic client registration; codes are single-use (deleted on exchange);
-- a grant is one client's access to one user's notes, holding the current access/refresh pair.
-- Expiry columns are epoch milliseconds. Secrets and tokens are stored as SHA-256 hashes only.
CREATE TABLE `oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`redirect_uris` text NOT NULL,
	`secret_hash` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`code_challenge` text NOT NULL,
	`scope` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `oauth_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`scope` text NOT NULL,
	`access_token_hash` text NOT NULL,
	`access_expires_at` integer NOT NULL,
	`refresh_token_hash` text NOT NULL,
	`refresh_expires_at` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_oauth_grants_access` ON `oauth_grants` (`access_token_hash`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_oauth_grants_refresh` ON `oauth_grants` (`refresh_token_hash`);
--> statement-breakpoint
CREATE INDEX `idx_oauth_grants_user` ON `oauth_grants` (`user_id`);
