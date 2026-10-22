-- A note published as a web page (/w/:id, application/webPagePublication.ts): a random,
-- revocable id per note. The page is rendered from the live note, so nothing else is stored.
CREATE TABLE `web_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`note_id` text NOT NULL,
	`public_epoch` integer NOT NULL DEFAULT 0,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_web_pages_note` ON `web_pages` (`note_id`);
