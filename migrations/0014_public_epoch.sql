-- Publications don't revive when a note goes private (or to the trash) and back (application/nodePublication.ts).
-- Both start at 0, so every existing publication of a public note keeps serving.
ALTER TABLE `notes` ADD `public_epoch` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `node_publications` ADD `public_epoch` integer NOT NULL DEFAULT 0;
