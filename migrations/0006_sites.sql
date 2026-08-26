CREATE TABLE `sites` (
	`publication_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`template` text NOT NULL,
	`html` text NOT NULL,
	`css` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_sites_user` ON `sites` (`user_id`);
