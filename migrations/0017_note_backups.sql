-- Automatic per-note backups (application/noteBackups.ts): NoteRoom snapshots the
-- note as it was before a commit, at most once per interval, and keeps the newest
-- few per note. Content is always encrypted (bound to the backup's own id), even
-- for a public note, so a note made private later leaves no plaintext behind.
CREATE TABLE `note_backups` (
	`id` text PRIMARY KEY NOT NULL,
	`note_id` text NOT NULL REFERENCES `notes`(`id`) ON DELETE CASCADE,
	`user_id` text NOT NULL REFERENCES `users`(`id`),
	`title` text NOT NULL,
	`content` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_note_backups_note` ON `note_backups` (`note_id`, `created_at`);
