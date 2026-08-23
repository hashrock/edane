CREATE TABLE `node_publications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`note_id` text NOT NULL,
	`node_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_node_publications_user` ON `node_publications` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_node_publications_note_node` ON `node_publications` (`note_id`, `node_id`);
