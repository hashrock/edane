-- Publications don't revive when a note stops being served (made private or trashed) and comes back
-- (application/nodePublication.ts). Both start at 0, so every existing publication of a public note keeps serving.
ALTER TABLE `notes` ADD `public_epoch` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `node_publications` ADD `public_epoch` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
-- One rule for every writer (NoteRoom commits, the trash route, MCP, scenarios, ...):
-- the epoch advances whenever a servable note (public, not trashed) stops being servable.
CREATE TRIGGER `notes_public_epoch` AFTER UPDATE OF `is_public`, `deleted_at` ON `notes`
WHEN OLD.`is_public` = 1 AND OLD.`deleted_at` IS NULL AND (NEW.`is_public` = 0 OR NEW.`deleted_at` IS NOT NULL)
BEGIN
  UPDATE `notes` SET `public_epoch` = `public_epoch` + 1 WHERE `id` = NEW.`id`;
END;
